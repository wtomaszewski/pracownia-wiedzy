#!/usr/bin/env python3
"""Single-household learning platform. SQLite is the source of truth."""
import csv
from contextlib import contextmanager, closing
import hashlib
import io
import json
import logging
import mimetypes
import os
import random
import re
import secrets
import sqlite3
import threading
import unicodedata
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('DATA_DIR', ROOT / 'data'))
DB = DATA / 'learning.sqlite3'
TOPICS, TESTS, SOURCES = {}, {}, []
SUBJECTS = {'polski': 'Polski', 'matematyka': 'Matematyka', 'angielski': 'Angielski', 'historia': 'Historia', 'przyroda': 'Przyroda'}
BACKUP_LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


@contextmanager
def connect():
    db = sqlite3.connect(DB, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        with db:
            yield db
    finally:
        db.close()


def load_content():
    TOPICS.clear(); TESTS.clear(); SOURCES.clear()
    all_ids = set()
    for file in sorted((ROOT / 'content').glob('*.json')):
        content = json.loads(file.read_text())
        SOURCES.extend(content.get('sources', []))
        for topic in content['topics']:
            assert topic['id'] not in TOPICS, 'Duplicate topic'
            assert topic['subject'] in SUBJECTS
            assert len(topic['questions']) >= 25, topic['id']
            for question in topic['questions']:
                assert question['id'] not in all_ids, question['id']
                all_ids.add(question['id'])
                kind = question.get('type', 'choice')
                assert kind in ('choice', 'multi', 'short', 'match', 'order'), question['id']
                if kind != 'short':
                    assert 2 <= len(question['options']) <= 8
                    assert all(isinstance(o,str) and o for o in question['options'])
                    assert len(set(question['options'])) == len(question['options']), question['id']
                if kind == 'match':
                    assert 2 <= len(question['items']) <= 6
                    assert len(set(question['items'])) == len(question['items'])
                validate_answer(question, question['answer'])
                assert is_correct(question, question['answer'])
                if 'image' in question:
                    assert re.fullmatch(r'/assets/nature/[a-z0-9-]+\.svg', question['image']['src'])
                    assert question['image']['alt']
                    assert (ROOT/'public'/question['image']['src'].lstrip('/')).is_file()
                assert all(question.get(key) for key in ('prompt', 'hint', 'explanation'))
            TOPICS[topic['id']] = topic
            # Authored diagnostics may have a fixed length and balanced skill coverage.
            if 'fixed_tests' in topic:
                by_id = {question['id']: question for question in topic['questions']}
                assert topic['fixed_tests'], topic['id']
                for test in topic['fixed_tests']:
                    ids = test['question_ids']
                    assert test['id'] not in TESTS and test['name'], test['id']
                    assert 1 <= len(ids) <= len(by_id) and len(set(ids)) == len(ids), test['id']
                    assert all(qid in by_id for qid in ids), test['id']
                    TESTS[test['id']] = {'id': test['id'], 'topic_id': topic['id'], 'name': test['name'], 'questions': [by_id[qid] for qid in ids], 'generated': False, 'created_at': None}
                continue
            # Five distinct selections; stable across restarts and independent of option order.
            bank = list(topic['questions'])
            random.Random('platforma-v1:' + topic['id']).shuffle(bank)
            for i in range(5):
                selected = [bank[(i * (len(bank) // 5) + offset) % len(bank)] for offset in range(10)]
                test_id = f"{topic['id']}-z{i + 1}"
                assert test_id not in TESTS, test_id
                TESTS[test_id] = {'id': test_id, 'topic_id': topic['id'], 'name': f'Zestaw {i + 1}', 'questions': selected, 'generated': False, 'created_at': None}


def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO settings VALUES ('name', 'Odkrywca');
        CREATE TABLE IF NOT EXISTS generated_tests (
            id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, name TEXT NOT NULL,
            questions TEXT NOT NULL, created_at TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (
            id TEXT PRIMARY KEY, test_id TEXT NOT NULL, topic_id TEXT NOT NULL, subject TEXT NOT NULL,
            title TEXT NOT NULL, test_name TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
            status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
            questions TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}', hints TEXT NOT NULL DEFAULT '[]',
            revision INTEGER NOT NULL DEFAULT 0, score INTEGER, total INTEGER NOT NULL,
            request_id TEXT UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS corrections (
            id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES attempts(id),
            question_id TEXT NOT NULL, selected TEXT NOT NULL, correct INTEGER NOT NULL,
            created_at TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL);
        CREATE INDEX IF NOT EXISTS attempts_date ON attempts(completed_at);
        CREATE INDEX IF NOT EXISTS corrections_attempt ON corrections(attempt_id, question_id);
        CREATE TRIGGER IF NOT EXISTS immutable_completed_attempt
            BEFORE UPDATE ON attempts WHEN OLD.status = 'completed'
            BEGIN SELECT RAISE(ABORT, 'Completed attempts are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS no_delete_completed_attempt
            BEFORE DELETE ON attempts WHEN OLD.status = 'completed'
            BEGIN SELECT RAISE(ABORT, 'Completed attempts are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_correction_update
            BEFORE UPDATE ON corrections BEGIN SELECT RAISE(ABORT, 'Corrections are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_correction_delete
            BEFORE DELETE ON corrections BEGIN SELECT RAISE(ABORT, 'Corrections are append-only'); END;
        ''')


def backup():
    """Consistent online snapshot; original DB and corrections remain untouched."""
    try:
        with BACKUP_LOCK:
            directory = DATA / 'backups'
            directory.mkdir(exist_ok=True)
            destination = directory / ('learning-' + now()[:10] + '.sqlite3')
            temporary = directory / '.snapshot.sqlite3'
            with connect() as source, closing(sqlite3.connect(temporary)) as target:
                source.backup(target)
            temporary.replace(destination)
    except Exception:
        logging.exception('Could not update backup; primary database is intact')


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def require(condition, message, status=400):
    if not condition:
        raise APIError(status, message)


def normalize_short(value):
    # This subject tests knowledge, not spelling or capitalization.
    value = unicodedata.normalize('NFKD', value.casefold().replace('ł','l'))
    return ' '.join(''.join(c for c in value if not unicodedata.combining(c)).strip().rstrip('.').split())


def validate_answer(q, value):
    kind = q.get('type', 'choice')
    if kind == 'short':
        require(isinstance(value,str) and 1 <= len(value.strip()) <= 120 and not any(ord(c)<32 for c in value), 'Wpisz krótką odpowiedź (do 120 znaków).')
    elif kind == 'match':
        require(isinstance(value,dict) and set(value)==set(q['items']) and all(isinstance(v,str) and v in q['options'] for v in value.values()), 'Dopasuj odpowiedź do każdego elementu.')
    elif kind in ('multi','order'):
        require(isinstance(value,list) and all(isinstance(v,str) for v in value), 'Wybierz elementy zadania.')
        require(len(value)==len(set(value)) and 1 <= len(value) <= len(q['options']) and set(value)<=set(q['options']), 'Zaznacz co najmniej jedną odpowiedź, bez powtórzeń.')
        if kind == 'order':
            require(set(value)==set(q['options']), 'Ułóż wszystkie elementy, każdy dokładnie raz.')
    else:
        require(isinstance(value,str) and value in q['options'], 'Wybierz odpowiedź z listy.')


def is_correct(q, value):
    kind = q.get('type','choice')
    if kind == 'short':
        return isinstance(value,str) and normalize_short(value) in {normalize_short(v) for v in [q['answer'], *q.get('accepted',[])]}
    if kind == 'multi':
        return isinstance(value,list) and set(value)==set(q['answer'])
    return value == q['answer']


def encode_selection(q, value):
    return dump(value) if q.get('type') in ('multi','match','order') else value


def request_key(body):
    key = body.get('request_id')
    require(isinstance(key, str) and 8 <= len(key) <= 100, 'Brak identyfikatora zapisu. Odśwież stronę.')
    return key


def find_attempt(db, attempt_id):
    row = db.execute('SELECT * FROM attempts WHERE id=?', (attempt_id,)).fetchone()
    require(row is not None, 'Nie znaleziono podejścia.', 404)
    return row


def attempt_summary(row, corrections=None):
    result = {key: row[key] for key in ('id','test_id','topic_id','subject','title','test_name','started_at','completed_at','status','score','total','revision')}
    answers = json.loads(row['answers'])
    result['answered'] = len(answers)
    result['percentage'] = round(row['score'] / row['total'] * 100, 1) if row['score'] is not None else None
    result['hints_used'] = len(json.loads(row['hints']))
    result['corrected'] = len({c['question_id'] for c in (corrections or []) if c['correct']})
    result['remaining'] = row['total'] - row['score'] - result['corrected'] if row['score'] is not None else 0
    return result


def attempt_detail(db, row):
    corrections = [dict(c) for c in db.execute('SELECT * FROM corrections WHERE attempt_id=? ORDER BY id', (row['id'],))]
    result = attempt_summary(row, corrections)
    result['answers'] = json.loads(row['answers'])
    result['hints'] = json.loads(row['hints'])
    result['questions'] = json.loads(row['questions'])
    by_id = {q['id']:q for q in result['questions']}
    for c in corrections:
        if by_id[c['question_id']].get('type') in ('multi','match','order'):
            c['selected'] = json.loads(c['selected'])
    result['corrections'] = corrections
    if row['status'] != 'completed':
        result['questions'] = [{k: v for k, v in q.items() if k not in ('answer','accepted','explanation')} for q in result['questions']]
    else:
        result['questions'] = [q | {'correct':is_correct(q,result['answers'].get(q['id']))} for q in result['questions']]
    result['attempt_number'] = db.execute('SELECT count(*) FROM attempts WHERE test_id=? AND rowid <= (SELECT rowid FROM attempts WHERE id=?)', (row['test_id'], row['id'])).fetchone()[0]
    return result


def get_test(db, test_id):
    require(isinstance(test_id,str), 'Nieprawidłowy zestaw.')
    if test_id in TESTS:
        return TESTS[test_id]
    row = db.execute('SELECT * FROM generated_tests WHERE id=?', (test_id,)).fetchone()
    require(row is not None, 'Nie znaleziono zestawu.', 404)
    return {'id': row['id'], 'topic_id': row['topic_id'], 'name': row['name'], 'questions': json.loads(row['questions']), 'generated': True, 'created_at': row['created_at']}


def catalog(db):
    sets = list(TESTS.values())
    for row in db.execute('SELECT * FROM generated_tests ORDER BY created_at DESC, rowid DESC'):
        sets.append({'id':row['id'],'topic_id':row['topic_id'],'name':row['name'],'questions':json.loads(row['questions']),'generated':True,'created_at':row['created_at']})
    return {
        'subjects': SUBJECTS,
        'topics': [{k:v for k,v in t.items() if k not in ('questions', 'fixed_tests')} | {'question_count': len(t['questions'])} for t in TOPICS.values()],
        'tests': [{k:v for k,v in test.items() if k != 'questions'} | {'total':len(test['questions'])} for test in sets],
        'sources': list({source['url']:source for source in SOURCES}.values()),
        'question_count': sum(len(t['questions']) for t in TOPICS.values()),
        'profile': {'name': db.execute("SELECT value FROM settings WHERE key='name'").fetchone()[0]},
    }


def list_attempts(db):
    corrections = {}
    for c in db.execute('SELECT attempt_id,question_id,correct FROM corrections'):
        corrections.setdefault(c['attempt_id'], []).append(c)
    return [attempt_summary(row, corrections.get(row['id'], [])) for row in db.execute('SELECT * FROM attempts ORDER BY COALESCE(completed_at,started_at) DESC,rowid DESC')]


def start_attempt(db, body):
    key = request_key(body)
    existing = db.execute('SELECT * FROM attempts WHERE request_id=?', (key,)).fetchone()
    if existing:
        require(existing['test_id'] == body.get('test_id'), 'Identyfikator należy do innego zestawu.', 409)
        return attempt_detail(db, existing)
    test = get_test(db, body.get('test_id', ''))
    topic = TOPICS[test['topic_id']]
    questions = json.loads(dump(test['questions']))
    random.SystemRandom().shuffle(questions)
    for q in questions:
        if 'options' in q:
            random.SystemRandom().shuffle(q['options'])
            if q.get('type') == 'order' and q['options'] == q['answer']:
                q['options'] = q['options'][1:] + q['options'][:1]
    attempt_id = secrets.token_hex(12)
    db.execute('INSERT INTO attempts(id,test_id,topic_id,subject,title,test_name,started_at,questions,total,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
               (attempt_id,test['id'],topic['id'],topic['subject'],topic['title'],test['name'],now(),dump(questions),len(questions),key))
    return attempt_detail(db, find_attempt(db, attempt_id))


def save_answer(db, row, body):
    require(row['status'] == 'in_progress', 'Ten wynik jest już zapisany. Użyj poprawki lub rozpocznij nowe podejście.', 409)
    require(type(body.get('revision')) is int and body['revision'] == row['revision'], 'Odpowiedzi zmieniły się w innej karcie. Wczytaj bieżący zapis.', 409)
    questions = {q['id']:q for q in json.loads(row['questions'])}
    qid = body.get('question_id')
    require(isinstance(qid,str) and qid in questions, 'Nieprawidłowe pytanie.')
    answers, hints = json.loads(row['answers']), set(json.loads(row['hints']))
    if 'answer' in body:
        validate_answer(questions[qid], body['answer'])
        answers[qid] = body['answer']
    if body.get('hint') is True:
        hints.add(qid)
    require('answer' in body or body.get('hint') is True, 'Brak odpowiedzi do zapisania.')
    db.execute('UPDATE attempts SET answers=?,hints=?,revision=revision+1 WHERE id=?', (dump(answers),dump(sorted(hints)),row['id']))
    return attempt_detail(db, find_attempt(db, row['id']))


def finish_attempt(db, row, body):
    if row['status'] == 'completed':
        return attempt_detail(db, row)
    require(type(body.get('revision')) is int and body['revision'] == row['revision'], 'Wczytaj bieżący zapis przed zakończeniem.', 409)
    questions, answers = json.loads(row['questions']), json.loads(row['answers'])
    require(len(answers) == len(questions), 'Odpowiedz na wszystkie pytania przed zakończeniem.')
    score = sum(is_correct(q, answers.get(q['id'])) for q in questions)
    db.execute("UPDATE attempts SET status='completed',completed_at=?,score=?,revision=revision+1 WHERE id=?", (now(),score,row['id']))
    return attempt_detail(db, find_attempt(db, row['id']))


def correct_answer(db, row, body):
    require(row['status'] == 'completed', 'Najpierw zakończ quiz.', 409)
    key = request_key(body)
    q = next((q for q in json.loads(row['questions']) if q['id'] == body.get('question_id')), None)
    require(q is not None, 'Nieprawidłowe pytanie.')
    validate_answer(q, body.get('answer'))
    selected = encode_selection(q,body['answer'])
    existing = db.execute('SELECT * FROM corrections WHERE request_id=?', (key,)).fetchone()
    if existing:
        require(existing['attempt_id'] == row['id'] and existing['question_id'] == body.get('question_id') and existing['selected'] == selected, 'Identyfikator należy do innej poprawki.', 409)
        return attempt_detail(db,row)
    require(not is_correct(q,json.loads(row['answers']).get(q['id'])), 'To pytanie rozwiązano poprawnie w pierwszym przejściu.')
    db.execute('INSERT INTO corrections(attempt_id,question_id,selected,correct,created_at,request_id) VALUES(?,?,?,?,?,?)',
               (row['id'],q['id'],selected,int(is_correct(q,body['answer'])),now(),key))
    return attempt_detail(db, row)


def generate_test(db, body):
    key = request_key(body)
    existing = db.execute('SELECT id,topic_id,questions FROM generated_tests WHERE request_id=?', (key,)).fetchone()
    if existing:
        require(existing['topic_id'] == body.get('topic_id') and len(json.loads(existing['questions'])) == body.get('count',10), 'Identyfikator należy do innego zestawu.', 409)
        return {'test_id': existing['id']}
    require(isinstance(body.get('topic_id'),str), 'Wybierz zagadnienie.')
    topic = TOPICS.get(body.get('topic_id', ''))
    require(topic is not None, 'Wybierz zagadnienie.')
    count = body.get('count', 10)
    require(type(count) is int and count in (10,15,20) and count <= len(topic['questions']), 'Wybierz 10, 15 lub 20 pytań.')
    uses = {}
    for row in db.execute('SELECT questions FROM attempts WHERE topic_id=?', (topic['id'],)):
        for q in json.loads(row['questions']):
            uses[q['id']] = uses.get(q['id'],0) + 1
    signatures = {tuple(sorted(q['id'] for q in t['questions'])) for t in TESTS.values() if t['topic_id'] == topic['id']}
    for row in db.execute('SELECT questions FROM generated_tests WHERE topic_id=?', (topic['id'],)):
        signatures.add(tuple(sorted(q['id'] for q in json.loads(row['questions']))))
    rng = random.SystemRandom()
    for trial in range(200):
        bank = list(topic['questions'])
        rng.shuffle(bank)
        if trial < 10:
            bank.sort(key=lambda q: uses.get(q['id'],0))
        selected = bank[:count]
        if tuple(sorted(q['id'] for q in selected)) not in signatures:
            break
    else:
        raise APIError(409, 'Wyczerpano różne kombinacje tej długości. Wybierz inną liczbę pytań.')
    number = db.execute('SELECT count(*) FROM generated_tests WHERE topic_id=?',(topic['id'],)).fetchone()[0] + 1
    test_id = 'gen-' + secrets.token_hex(10)
    db.execute('INSERT INTO generated_tests VALUES(?,?,?,?,?,?)', (test_id,topic['id'],f'Twój zestaw {number}',dump(selected),now(),key))
    return {'test_id':test_id}


class Handler(BaseHTTPRequestHandler):
    server_version = 'Pracownia'

    def log_message(self, fmt, *args):
        logging.info('%s %s', self.command, self.path.split('?')[0])

    def send(self, status, data, content_type='application/json; charset=utf-8', attachment=None):
        payload = dump(data).encode() if content_type.startswith('application/json') else data
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(payload)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
        if attachment:
            self.send_header('Content-Disposition',f'attachment; filename="{attachment}"')
        self.end_headers()
        self.wfile.write(payload)

    def body(self):
        origin = self.headers.get('Origin')
        require(not origin or urlparse(origin).netloc == self.headers.get('Host'), 'Niedozwolone źródło żądania.', 403)
        require(self.headers.get('X-Quiz-Request') == '1', 'Brak nagłówka zapisu.', 403)
        require(self.headers.get('Content-Type','').split(';')[0] == 'application/json', 'Wymagany format JSON.', 415)
        try:
            length = int(self.headers.get('Content-Length','0'))
        except ValueError:
            raise APIError(400,'Nieprawidłowa długość żądania.')
        require(0 < length <= 65536, 'Nieprawidłowy rozmiar danych.', 413)
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise APIError(400, 'Nieprawidłowe dane JSON.')
        require(isinstance(value,dict), 'Wymagany obiekt JSON.')
        return value

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == '/api/health':
                with connect() as db:
                    db.execute('SELECT count(*) FROM attempts').fetchone()
                self.send(200, {'ok':True,'topics':len(TOPICS),'questions':sum(len(t['questions']) for t in TOPICS.values())}); return
            if path.startswith('/api/'):
                with connect() as db:
                    if path == '/api/catalog':
                        self.send(200,catalog(db)); return
                    if path == '/api/attempts':
                        self.send(200,{'attempts':list_attempts(db)}); return
                    match = re.fullmatch('/api/attempts/([a-f0-9]{24})',path)
                    if match:
                        self.send(200,attempt_detail(db,find_attempt(db,match[1]))); return
                    if path == '/api/export.json':
                        result = {'format':'pracownia-wiedzy-v1','exported_at':now(),'catalog':catalog(db),'attempts':[attempt_detail(db,r) for r in db.execute('SELECT * FROM attempts ORDER BY rowid')], 'generated_tests':[dict(r) for r in db.execute('SELECT * FROM generated_tests')]}
                        self.send(200,result,attachment='pracownia-historia.json'); return
                    if path == '/api/export.csv':
                        output = io.StringIO(); writer = csv.writer(output,delimiter=';')
                        writer.writerow(['Data rozpoczęcia UTC','Data ukończenia UTC','Przedmiot','Zagadnienie','Zestaw','Status','Punkty','Maksimum','Procent','Poprawione błędy','Błędy do poprawy'])
                        for a in list_attempts(db):
                            writer.writerow([a['started_at'],a['completed_at'],SUBJECTS[a['subject']],a['title'],a['test_name'],a['status'],a['score'],a['total'],a['percentage'],a['corrected'],a['remaining']])
                        self.send(200,('\ufeff'+output.getvalue()).encode(),'text/csv; charset=utf-8','pracownia-historia.csv'); return
                raise APIError(404,'Nie znaleziono zasobu.')
            filename = 'index.html' if path == '/' else path.lstrip('/')
            require(filename in ('index.html','app.js','style.css','favicon.svg') or re.fullmatch(r'assets/nature/[a-z0-9-]+\.svg',filename), 'Nie znaleziono strony.',404)
            file = ROOT / 'public' / filename
            require(file.is_file(), 'Nie znaleziono pliku.',404)
            self.send(200,file.read_bytes(),(mimetypes.guess_type(file.name)[0] or 'application/octet-stream')+'; charset=utf-8')
        except APIError as error:
            self.send(error.status, {'error':error.message})
        except Exception:
            logging.exception('GET failed')
            self.send(500,{'error':'Nie udało się odczytać danych. Spróbuj ponownie.'})

    def do_POST(self):
        try:
            body = self.body()
            path = urlparse(self.path).path
            take_backup = False
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if path == '/api/attempts':
                    result = start_attempt(db,body)
                elif path == '/api/generate':
                    result = generate_test(db,body); take_backup = True
                elif path == '/api/profile':
                    name = body.get('name')
                    require(isinstance(name,str) and 1 <= len(name.strip()) <= 32, 'Wpisz imię lub pseudonim (1–32 znaki).')
                    require(not any(ord(c) < 32 for c in name),'Usuń znaki sterujące.')
                    db.execute("UPDATE settings SET value=? WHERE key='name'", (name.strip(),))
                    result = {'name':name.strip()}
                else:
                    match = re.fullmatch('/api/attempts/([a-f0-9]{24})/(answer|finish|correct)',path)
                    require(match is not None,'Nie znaleziono działania.',404)
                    row = find_attempt(db,match[1])
                    if match[2] == 'answer':
                        result = save_answer(db,row,body)
                    elif match[2] == 'finish':
                        result = finish_attempt(db,row,body); take_backup = True
                    else:
                        result = correct_answer(db,row,body); take_backup = True
            if take_backup:
                backup()
            self.send(200,result)
        except APIError as error:
            self.send(error.status,{'error':error.message})
        except Exception:
            logging.exception('POST failed')
            self.send(500,{'error':'Zapis nie został potwierdzony. Wczytaj bieżący stan przed ponowną próbą.'})


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    load_content(); init_db()
    host, port = os.environ.get('BIND','0.0.0.0'), int(os.environ.get('PORT','8080'))
    logging.info('Pracownia: http://%s:%s/ — %s topics, %s tests',host,port,len(TOPICS),len(TESTS))
    ThreadingHTTPServer((host,port),Handler).serve_forever()
