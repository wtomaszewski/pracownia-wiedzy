from contextlib import closing
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid
from collections import Counter
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('platform_server', ROOT / 'server.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class PlatformTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.DATA = Path(self.temp.name)
        app.DB = app.DATA / 'learning.sqlite3'
        app.load_content(); app.init_db()
        self.server = app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        self.temp.cleanup()

    def call(self,path,body=None,headers=None):
        request=Request(self.url+path,data=json.dumps(body).encode() if body is not None else None,
            headers=headers if headers is not None else {'Content-Type':'application/json','X-Quiz-Request':'1'})
        try:
            with urlopen(request) as response:return response.status,json.loads(response.read())
        except HTTPError as error:
            with error:return error.code,json.loads(error.read())

    def start(self,request_id=None,test_id=None):
        return self.call('/api/attempts',{'test_id':test_id or next(iter(app.TESTS)),'request_id':request_id or uuid.uuid4().hex})[1]

    def complete(self,wrong=2):
        a=self.start()
        with app.connect() as db:
            keys={q['id']:q['answer'] for q in json.loads(app.find_attempt(db,a['id'])['questions'])}
        for i,q in enumerate(a['questions']):
            choice=next(o for o in q['options'] if o!=keys[q['id']]) if i<wrong else keys[q['id']]
            code,a=self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':choice,'revision':a['revision']})
            self.assertEqual(code,200)
        code,a=self.call(f"/api/attempts/{a['id']}/finish",{'revision':a['revision']})
        self.assertEqual(code,200)
        return a

    def test_catalog_has_five_meaningfully_distinct_sets_per_topic(self):
        code,cat=self.call('/api/catalog')
        self.assertEqual(code,200)
        self.assertEqual(set(cat['subjects']),{'polski','matematyka','angielski','historia','przyroda'})
        self.assertGreaterEqual(len(cat['topics']),20)
        self.assertGreaterEqual(cat['question_count'],900)
        for topic in app.TOPICS.values():
            if 'fixed_tests' in topic:
                continue
            tests=[test for test in app.TESTS.values() if test['topic_id']==topic['id']]
            self.assertEqual(len(tests),5)
            signatures={tuple(sorted(q['id'] for q in t['questions'])) for t in tests}
            self.assertEqual(len(signatures),5)
            self.assertTrue(all(len(t['questions'])==10 for t in tests))
            if len(topic['questions'])==50:
                self.assertEqual(len({q['id'] for t in tests for q in t['questions']}),50)

    def test_unit_one_diagnostics_are_balanced_distinct_and_score_out_of_twenty(self):
        tests=[test for test in app.TESTS.values() if test['topic_id']=='en-rozdzial-1-diagnoza']
        self.assertEqual(len(tests),2)
        members=[]
        for test in tests:
            self.assertEqual(len(test['questions']),20)
            self.assertEqual(Counter(q['skill'] for q in test['questions']),
                             {'family':3,'places':2,'countries':3,'to_be':5,'possessive_s':3,'possessives':4})
            members.append({q['id'] for q in test['questions']})
            keys={q['id']:q['answer'] for q in test['questions']}
            a=self.start(test_id=test['id'])
            self.assertEqual(a['total'],20)
            self.assertTrue(all('answer' not in q and 'explanation' not in q for q in a['questions']))
            for i,q in enumerate(a['questions']):
                answer=keys[q['id']] if i else next(o for o in q['options'] if o!=keys[q['id']])
                code,a=self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':answer,'revision':a['revision']})
                self.assertEqual(code,200)
            code,a=self.call(f"/api/attempts/{a['id']}/finish",{'revision':a['revision']})
            self.assertEqual(code,200)
            self.assertEqual((a['score'],a['total'],a['percentage']),(19,20,95))
            wrong=next(q for q in a['questions'] if a['answers'][q['id']]!=q['answer'])
            code,corrected=self.call(f"/api/attempts/{a['id']}/correct",{'question_id':wrong['id'],'answer':wrong['answer'],'request_id':uuid.uuid4().hex})
            self.assertEqual(code,200)
            self.assertEqual((corrected['score'],corrected['percentage'],corrected['corrected']),(19,95,1))
            app.load_content()
            self.assertEqual({q['id'] for q in app.TESTS[test['id']]['questions']},members[-1])
            self.assertEqual(self.call('/api/attempts/'+a['id'])[1]['score'],19)
        self.assertFalse(members[0]&members[1])

    def test_resume_idempotency_and_concurrent_tab_conflict(self):
        key=uuid.uuid4().hex;a=self.start(key);b=self.start(key)
        self.assertEqual(a['id'],b['id'])
        self.assertNotIn('answer',a['questions'][0])
        q=a['questions'][0]
        body={'question_id':q['id'],'answer':q['options'][0],'revision':a['revision']}
        code,saved=self.call(f"/api/attempts/{a['id']}/answer",body);self.assertEqual(code,200)
        self.assertEqual(self.call(f"/api/attempts/{a['id']}/answer",body)[0],409)
        app.init_db();app.load_content()
        restored=self.call('/api/attempts/'+a['id'])[1]
        self.assertEqual(restored['answers'],saved['answers'])
        self.assertEqual(restored['questions'],a['questions'])
        self.assertEqual(self.call(f"/api/attempts/{a['id']}/finish",{'revision':saved['revision']})[0],400)

    def test_original_score_immutable_and_every_correction_recorded(self):
        a=self.complete(wrong=2)
        self.assertEqual((a['score'],a['percentage'],a['remaining']),(8,80,2))
        q=next(q for q in a['questions'] if a['answers'][q['id']]!=q['answer'])
        endpoint=f"/api/attempts/{a['id']}/correct"
        wrong={'request_id':uuid.uuid4().hex,'question_id':q['id'],'answer':a['answers'][q['id']]}
        code,b=self.call(endpoint,wrong);self.assertEqual(code,200);self.assertEqual(b['corrected'],0)
        correct={**wrong,'request_id':uuid.uuid4().hex,'answer':q['answer']}
        code,b=self.call(endpoint,correct);self.assertEqual(code,200)
        self.assertEqual((b['score'],b['percentage'],b['corrected'],b['remaining']),(8,80,1,1))
        self.assertEqual(len(b['corrections']),2)
        again=self.call(endpoint,correct)[1];self.assertEqual(len(again['corrections']),2)
        self.assertEqual(self.call(f"/api/attempts/{a['id']}/finish",{})[1]['score'],8)
        self.assertEqual(self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':q['answer'],'revision':b['revision']})[0],409)
        with app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):db.execute('UPDATE attempts SET score=10 WHERE id=?',(a['id'],))
            with self.assertRaises(sqlite3.IntegrityError):db.execute('DELETE FROM corrections WHERE attempt_id=?',(a['id'],))
        new=self.start(test_id=a['test_id']);self.assertNotEqual(new['id'],a['id']);self.assertEqual(new['attempt_number'],2)
        self.assertEqual(self.call('/api/attempts/'+a['id'])[1]['answers'],a['answers'])
        backup=list((app.DATA/'backups').glob('*.sqlite3'))[0]
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('SELECT score FROM attempts WHERE id=?',(a['id'],)).fetchone()[0],8)
            self.assertEqual(db.execute('SELECT count(*) FROM corrections').fetchone()[0],2)

    def test_generator_persists_new_sets_with_unique_membership(self):
        topic_id=next(iter(app.TOPICS))
        body={'topic_id':topic_id,'count':15,'request_id':uuid.uuid4().hex}
        code,first=self.call('/api/generate',body);self.assertEqual(code,200)
        self.assertEqual(first,self.call('/api/generate',body)[1])
        signatures=[]
        for i in range(8):
            code,result=self.call('/api/generate',{**body,'request_id':uuid.uuid4().hex});self.assertEqual(code,200)
            with app.connect() as db:signatures.append(tuple(sorted(q['id'] for q in app.get_test(db,result['test_id'])['questions'])))
        self.assertEqual(len(set(signatures)),8)
        app.load_content();app.init_db()
        a=self.start(test_id=first['test_id']);self.assertEqual(a['total'],15)
        self.assertIn(first['test_id'],[t['id'] for t in self.call('/api/catalog')[1]['tests']])

    def test_invalid_answers_and_cross_origin_requests_rejected(self):
        a=self.start();q=a['questions'][0]
        url=f"/api/attempts/{a['id']}/answer"
        body={'question_id':q['id'],'answer':'arbitrary answer','revision':0}
        self.assertEqual(self.call(url,body)[0],400)
        self.assertEqual(self.call(url,body,{'Content-Type':'application/json'})[0],403)
        self.assertEqual(self.call(url,body,{'Content-Type':'application/json','X-Quiz-Request':'1','Origin':'https://unrelated.example'})[0],403)
        self.assertEqual(self.call('/api/generate',{'topic_id':next(iter(app.TOPICS)),'count':10000,'request_id':uuid.uuid4().hex})[0],400)
        self.assertEqual(self.call('/api/attempts/'+a['id'])[1]['answers'],{})

    def test_export_includes_attempt_and_correction_dates(self):
        a=self.complete(wrong=0)
        export=self.call('/api/export.json')[1]
        self.assertEqual(export['format'],'pracownia-wiedzy-v1')
        self.assertEqual(export['attempts'][0]['completed_at'],a['completed_at'])
        self.assertEqual(export['attempts'][0]['score'],10)
        with urlopen(self.url+'/api/export.csv') as response:
            self.assertIn('Data ukończenia UTC',response.read().decode('utf-8-sig'))

    def test_nature_ten_disjoint_tests_and_all_answer_types_score(self):
        topics=[t for t in app.TOPICS.values() if t['subject']=='przyroda']
        self.assertEqual(len(topics),5)
        prompts=[q['prompt'] for t in topics for q in t['questions']]
        self.assertEqual(len(prompts),150)
        self.assertEqual(len(set(prompts)),150)
        for topic in topics:
            tests=[t for t in app.TESTS.values() if t['topic_id']==topic['id']]
            self.assertEqual(len(tests),2)
            members=[{q['id'] for q in t['questions']} for t in tests]
            self.assertFalse(members[0]&members[1])
            for test in tests:
                self.assertEqual(len(test['questions']),15)
                self.assertGreaterEqual(len({q['type'] for q in test['questions']}),4)
                keys={q['id']:q for q in test['questions']}
                a=self.start(test_id=test['id'])
                self.assertTrue(all(not {'answer','accepted','explanation'}&set(q) for q in a['questions']))
                for q in a['questions']:
                    original=keys[q['id']]
                    value=original['answer']
                    if q['type']=='short':
                        # Answers without accents, capitals and surrounding spaces are knowledge-equivalent.
                        value='  '+value.translate(str.maketrans('ąćęłńóśźż','acelnoszz')).upper()+'  '
                    elif q['type']=='multi':
                        value=list(reversed(value))
                    elif q['type']=='match':
                        value=dict(reversed(list(value.items())))
                    elif q['type']=='order':
                        self.assertNotEqual(q['options'],value)
                    code,a=self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':value,'revision':a['revision']})
                    self.assertEqual(code,200)
                code,a=self.call(f"/api/attempts/{a['id']}/finish",{'revision':a['revision']})
                self.assertEqual(code,200)
                self.assertEqual((a['score'],a['total'],a['percentage']),(15,15,100))
                self.assertTrue(all(q['correct'] for q in a['questions']))
        for path in (ROOT/'public/assets/nature').glob('*.svg'):
            with urlopen(self.url+'/assets/nature/'+path.name) as response:
                self.assertEqual(response.status,200)
                self.assertIn('image/svg+xml',response.headers['Content-Type'])

    def test_structured_corrections_preserve_score_answers_and_export(self):
        test=app.TESTS['pr-doswiadczenia-a-v1']
        keys={q['id']:q for q in test['questions']}
        a=self.start(test_id=test['id'])
        wrong={}
        for q in a['questions']:
            original=keys[q['id']];value=original['answer'];kind=q['type']
            if kind not in wrong:
                if kind=='short':value='inna odpowiedź'
                elif kind=='order':value=list(reversed(value))
                elif kind=='multi':value=[next(o for o in q['options'] if o not in value)]
                elif kind=='match':
                    value=dict(value);item=q['items'][0]
                    value[item]=next(o for o in q['options'] if o!=value[item])
                else:value=next(o for o in q['options'] if o!=value)
                wrong[kind]=q['id']
            code,a=self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':value,'revision':a['revision']})
            self.assertEqual(code,200)
        # Reload while in progress: structured JSON and ordering survive.
        app.load_content();app.init_db()
        restored=self.call('/api/attempts/'+a['id'])[1]
        self.assertEqual(restored['answers'],a['answers'])
        self.assertEqual(restored['questions'],a['questions'])
        code,a=self.call(f"/api/attempts/{a['id']}/finish",{'revision':a['revision']})
        self.assertEqual(code,200)
        self.assertEqual((a['score'],a['total'],a['percentage']),(10,15,66.7))
        original_answers=a['answers']
        for kind,qid in wrong.items():
            endpoint=f"/api/attempts/{a['id']}/correct"
            body={'question_id':qid,'answer':keys[qid]['answer'],'request_id':uuid.uuid4().hex}
            code,a=self.call(endpoint,body);self.assertEqual(code,200)
            self.assertEqual(a['corrections'][-1]['selected'],body['answer'])
            self.assertTrue(a['corrections'][-1]['correct'])
            self.assertEqual(self.call(endpoint,body)[1]['corrections'],a['corrections'])
            self.assertEqual((a['score'],a['percentage'],a['answers']),(10,66.7,original_answers))
        self.assertEqual((a['corrected'],a['remaining']),(5,0))
        self.assertEqual(sum(q['correct'] for q in a['questions']),10)
        exported=self.call('/api/export.json')[1]['attempts'][0]
        self.assertEqual(exported['answers'],original_answers)
        self.assertEqual(exported['corrections'],a['corrections'])
        with app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('UPDATE attempts SET answers=? WHERE id=?',('{}',a['id']))
        code,generated=self.call('/api/generate',{'topic_id':test['topic_id'],'count':15,'request_id':uuid.uuid4().hex})
        self.assertEqual(code,200)
        fresh=self.start(test_id=generated['test_id'])
        self.assertEqual(len(fresh['questions']),15)
        self.assertTrue(all('answer' not in q and 'accepted' not in q for q in fresh['questions']))

    def test_malformed_structured_answers_never_change_saved_work(self):
        a=self.start(test_id='pr-doswiadczenia-a-v1')
        by_type={q['type']:q for q in a['questions']}
        for kind,q in by_type.items():
            values=[None,False,123,{},[],['unknown'],{'unexpected':'value'}]
            if kind=='short':values+=['',' '*5,'a'*121,'a\nb']
            elif kind=='match':values+=[{q['items'][0]:q['options'][0]},dict.fromkeys(q['items'],'unknown')]
            elif kind in ('multi','order'):values+=[[q['options'][0],q['options'][0]],['unknown',q['options'][0]],[[q['options'][0]]]]
            if kind=='order':values+=[[q['options'][0]]]
            for value in values:
                with self.subTest(kind=kind,value=value):
                    code,_=self.call(f"/api/attempts/{a['id']}/answer",{'question_id':q['id'],'answer':value,'revision':0})
                    self.assertEqual(code,400)
        restored=self.call('/api/attempts/'+a['id'])[1]
        self.assertEqual((restored['answers'],restored['revision']),({},0))
        self.assertEqual(self.call(f"/api/attempts/{a['id']}/finish",{'revision':0})[0],400)


if __name__=='__main__':unittest.main(verbosity=2)
