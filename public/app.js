'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const counted = (n,one,few,many) => n+' '+(n===1?one:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?few:many);
  const symbols = {polski:'Aa',matematyka:'＋',angielski:'Hi!',historia:'⌛',przyroda:'❧'};
  const descriptions = {polski:'Słowa, zdania i niezwykłe opowieści.',matematyka:'Licz, odkrywaj i szukaj rozwiązań.',angielski:'Małe rozmowy. Coraz większa pewność.',historia:'Odkrywaj, skąd znamy przeszłość.',przyroda:'Okiem badacza: obserwuj, dopasuj, odkrywaj.'};
  const number = value => new Intl.NumberFormat('pl-PL',{maximumFractionDigits:1}).format(value);
  const date = value => value ? new Intl.DateTimeFormat('pl-PL',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'}).format(new Date(value)) : '—';
  const localDay = value => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  let catalog, attempts = [], current = null, position = 0, saving = false, routeVersion = 0;
  let pendingStart = null, pendingGeneration = null, pendingCorrection = null;
  let historyFilters = {subject:'',status:'',from:'',to:'',search:''};
  let correctionFeedback = null;
  let drafts = {};
  try { const saved=JSON.parse(sessionStorage.getItem('quiz-drafts-v1')||'{}'); if(saved&&typeof saved==='object'&&!Array.isArray(saved))drafts=saved; } catch {}

  const questionType = q => q.type || 'choice';
  const correctInitially = q => q.correct ?? current.answers[q.id]===q.answer;
  const draftKey = q => current.id+':'+q.id;
  const typeLabels = {choice:'WYBIERZ JEDNĄ ODPOWIEDŹ',multi:'ZAZNACZ WSZYSTKIE PASUJĄCE',short:'WPISZ KRÓTKĄ ODPOWIEDŹ',match:'DOPASUJ ELEMENTY',order:'UŁÓŻ W KOLEJNOŚCI'};
  function persistDrafts() { try {sessionStorage.setItem('quiz-drafts-v1',JSON.stringify(drafts));} catch {} }
  function illustration(q) {
    return q.image ? `<figure class="task-figure"><img src="${esc(q.image.src)}" alt="${esc(q.image.alt)}">${q.image.caption?`<figcaption>${esc(q.image.caption)}</figcaption>`:''}</figure>` : '';
  }
  function answerText(q,value) {
    if(value===undefined||value===null)return '—';
    if(questionType(q)==='match')return q.items.map(item=>item+': '+(value[item]||'—')).join('\n');
    if(Array.isArray(value))return value.join(questionType(q)==='order'?' → ':' • ');
    return String(value);
  }
  function answerFields(q,value) {
    const kind=questionType(q);
    if(kind==='short')return `<label class="short-label" for="short-answer">${esc(q.input_label||'Twoja odpowiedź')}</label><div class="short-answer-row"><input id="short-answer" name="short" type="text" maxlength="120" autocomplete="off" spellcheck="false" required value="${esc(value||'')}">${q.unit?`<span>${esc(q.unit)}</span>`:''}</div><p class="small muted">Wielkość liter i brak polskich znaków nie wpływają na ocenę.</p>`;
    if(kind==='match')return `<div class="matching-fields">${q.items.map((item,i)=>`<label><span>${esc(item)}</span><select name="match-${i}" required><option value="">Wybierz…</option>${q.options.map(option=>`<option value="${esc(option)}" ${value?.[item]===option?'selected':''}>${esc(option)}</option>`).join('')}</select></label>`).join('')}</div>`;
    if(kind==='order'){
      const ordered=Array.isArray(value)&&value.length===q.options.length?value:q.options;
      return `<p class="small muted">Użyj strzałek, aby przesunąć elementy. Na górze ma być pierwszy krok.</p><ol class="order-list">${ordered.map((item,i)=>`<li class="order-row" data-value="${esc(item)}"><span class="order-number">${i+1}</span><span class="order-text">${esc(item)}</span><div class="order-buttons"><button type="button" data-move="-1" aria-label="Przesuń w górę: ${esc(item)}" ${i===0?'disabled':''}>↑</button><button type="button" data-move="1" aria-label="Przesuń w dół: ${esc(item)}" ${i===ordered.length-1?'disabled':''}>↓</button></div></li>`).join('')}</ol>`;
    }
    return `<fieldset class="practice-options"><legend class="sr-only">${kind==='multi'?'Zaznacz wszystkie pasujące odpowiedzi':'Wybierz odpowiedź'}</legend>${q.options.map((option,i)=>`<label class="practice-option"><input type="${kind==='multi'?'checkbox':'radio'}" name="selection" value="${i}" ${kind==='multi'?(Array.isArray(value)&&value.includes(option)?'checked':''):(value===option?'checked':'')}><span>${esc(option)}</span></label>`).join('')}</fieldset>`;
  }
  function readAnswer(q,form,validate=true) {
    const data=new FormData(form), kind=questionType(q);let value;
    if(kind==='short')value=String(data.get('short')||'').trim();
    else if(kind==='match')value=Object.fromEntries(q.items.map((item,i)=>[item,String(data.get('match-'+i)||'')]));
    else if(kind==='order')value=Array.from(form.querySelectorAll('.order-row'),row=>row.dataset.value);
    else if(kind==='multi')value=data.getAll('selection').map(i=>q.options[Number(i)]);
    else value=data.has('selection')?q.options[Number(data.get('selection'))]:undefined;
    if(validate){
      if(kind==='short'&&!value)throw new Error('Wpisz odpowiedź.');
      if(kind==='match'&&Object.values(value).some(v=>!v))throw new Error('Uzupełnij wszystkie dopasowania.');
      if(kind==='multi'&&!value.length)throw new Error('Zaznacz przynajmniej jedną odpowiedź.');
      if(kind==='choice'&&value===undefined)throw new Error('Wybierz odpowiedź.');
    }
    return value;
  }
  function rememberDraft() {
    const form=$('answer-form'); if(!form||!current)return;
    const q=current.questions.find(q=>q.id===form.dataset.question);
    drafts[draftKey(q)]=readAnswer(q,form,false);persistDrafts();
    if($('save-status'))$('save-status').textContent='Odpowiedź robocza jest w tej przeglądarce. Kliknij „Zapisz odpowiedź” lub „Dalej”, aby zapisać ją na serwerze.';
  }

  async function api(path, body) {
    let response;
    try {
      response = await fetch('/api' + path, {cache:'no-store', ...(body ? {method:'POST',headers:{'Content-Type':'application/json','X-Quiz-Request':'1'},body:JSON.stringify(body)} : {})});
    } catch {
      throw new Error('Brak połączenia z serwerem. Ostatni potwierdzony zapis jest bezpieczny. Spróbuj ponownie.');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('Serwer nie odpowiedział poprawnie. Spróbuj ponownie.'); }
    if (!response.ok) { const error = new Error(data.error || 'Nie udało się wykonać działania.'); error.status = response.status; throw error; }
    return data;
  }

  function notify(message, error=false) {
    $('notice').textContent = message; $('notice').hidden = !message;
    $('notice').className = 'notice' + (error ? ' error' : '');
    $('notice').setAttribute('role',error ? 'alert' : 'status');
  }

  function completed() { return attempts.filter(a=>a.status==='completed'); }
  function remaining() { return completed().reduce((sum,a)=>sum+a.remaining,0); }
  function subjectName(id) { return catalog.subjects[id] || id; }
  function topic(id) { return catalog.topics.find(t=>t.id===id); }
  function subjectBadge(subject) { return `<span class="subject-badge ${esc(subject)}">${esc(subjectName(subject))}</span>`; }
  function empty(title,text,action='') { return `<div class="empty"><span class="empty-symbol" aria-hidden="true">✦</span><h3>${title}</h3><p>${text}</p>${action}</div>`; }
  function heading(eyebrow,title,description='',action='') { return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${description ? `<p class="lead">${description}</p>`:''}</div>${action}</div>`; }
  function progress(value,max=100) { return `<progress value="${Number(value)}" max="${max}" aria-label="Postęp: ${number(value)} z ${max}"></progress>`; }

  async function refresh() {
    const data = await Promise.all([api('/catalog'),api('/attempts')]);
    catalog = data[0]; attempts = data[1].attempts;
    $('profile-name').textContent = catalog.profile.name;
    $('mistake-badge').textContent = remaining(); $('mistake-badge').hidden = !remaining();
  }

  function setPage(html, title, nav) {
    $('content').innerHTML = html; $('breadcrumb').textContent = title;
    document.title = `${title} · Pracownia wiedzy`;
    document.querySelectorAll('[data-nav]').forEach(link => {
      link.classList.toggle('active', link.dataset.nav === nav);
      if (link.dataset.nav === nav) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
    });
  }

  function subjectCards() {
    return `<div class="subject-grid">${Object.keys(catalog.subjects).map(id=>{
      const topics = catalog.topics.filter(t=>t.subject===id), done = completed().filter(a=>a.subject===id);
      const sets = catalog.tests.filter(t=>topics.some(topic=>topic.id===t.topic_id));
      return `<a class="subject-card ${id}" href="#/subject/${id}"><div class="card-top"><span class="subject-symbol" aria-hidden="true">${symbols[id]}</span><span class="arrow" aria-hidden="true">↗</span></div><h3>${subjectName(id)}</h3><p>${descriptions[id]}</p><div class="card-bottom"><span>${topics.length} zagadnień · ${sets.length} zestawów</span><b>${done.length ? done.length+' ukończonych' : 'Zaczynamy?'}</b></div></a>`;
    }).join('')}</div>`;
  }

  function historyTable(rows, compact=false) {
    if (!rows.length) return empty('Tu pojawią się Twoje wyniki','Rozwiąż pierwszy zestaw. Zapiszemy datę, punkty i wynik procentowy.','<a class="button primary" href="#/subjects">Wybierz przedmiot →</a>');
    return `<div class="table-scroll"><table class="history-table"><caption class="sr-only">Podejścia do quizów i ich pierwotne wyniki</caption><thead><tr><th>Test i data</th><th>Przedmiot</th><th>Wynik</th><th>Poprawki</th><th><span class="sr-only">Otwórz</span></th></tr></thead><tbody>${rows.map(a=>`<tr><td><a class="table-title" href="#/attempt/${a.id}">${esc(a.title)}</a><span class="table-sub">${esc(a.test_name)} · ${date(a.completed_at||a.started_at)}</span></td><td>${subjectBadge(a.subject)}</td><td>${a.status==='completed' ? `<strong>${a.score} / ${a.total}</strong><span class="percentage ${a.percentage>=80?'good':''}">${number(a.percentage)}%</span>` : `<span class="status-pill">W trakcie · ${a.answered}/${a.total}</span>`}</td><td>${a.status!=='completed'?'—':a.remaining ? `<a href="#/attempt/${a.id}">${a.remaining} do poprawy</a>` : a.corrected ? `<span class="positive">${a.corrected} poprawionych</span>` : '<span class="muted">Bez błędów</span>'}</td><td><a class="text-link nowrap" href="#/attempt/${a.id}">${a.status==='completed'?'Szczegóły':'Wznów'} →</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function home() {
    const done = completed(), active = attempts.filter(a=>a.status==='in_progress');
    const average = done.length ? done.reduce((sum,a)=>sum+a.percentage,0)/done.length : null;
    const days = new Set(done.map(a=>localDay(a.completed_at))).size;
    const recommendation = remaining() ? '<a class="button light" href="#/mistakes">Poćwicz błędy ↗</a>' : '<a class="button light" href="#/subjects">Wybierz swój test ↗</a>';
    setPage(`<section class="welcome"><div><p class="eyebrow">CZEŚĆ, ${esc(catalog.profile.name.toLocaleUpperCase('pl'))}!</p><h1>Czego dziś<br>się nauczysz?</h1><p>Pięć przedmiotów. Twoje tempo.<br>Każdy kolejny krok zostaje z Tobą.</p>${recommendation}</div><div class="welcome-art" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="art-tile tile-a">Aa</span><span class="art-tile tile-b">＋</span><span class="art-tile tile-c">Hi!</span><span class="art-star">✦</span><span class="art-dot"></span></div></section>
      <div class="stats-grid"><article class="stat"><span>Ukończone testy</span><strong>${done.length}</strong><small>Każde podejście jest zapisane</small></article><article class="stat"><span>Średni wynik</span><strong>${average===null?'—':number(average)+'<em>%</em>'}</strong><small>Wyniki przed poprawkami</small></article><a class="stat clickable" href="#/mistakes"><span>Błędy do poćwiczenia</span><strong>${remaining()}</strong><small>${remaining()?'Małe kroki do lepszego zrozumienia':'Tu znajdziesz zadania do powtórki'}</small></a><article class="stat"><span>Dni z nauką</span><strong>${days}</strong><small>Liczy się systematyczność</small></article></div>
      ${active.length?`<section class="resume-banner"><div><span class="eyebrow">DOKOŃCZ SPOKOJNIE</span><h2>${esc(active[0].title)}</h2><p>${esc(active[0].test_name)} · zapisano ${active[0].answered} z ${active[0].total} odpowiedzi${active.length>1?` · ${active.length} testów w trakcie`:''}</p></div><a class="button primary" href="#/attempt/${active[0].id}">Wróć do testu →</a></section>`:''}
      <section><div class="section-heading"><h2>Twoje przedmioty</h2><a class="text-link" href="#/subjects">Wszystkie zagadnienia →</a></div>${subjectCards()}</section>
      <div class="dashboard-bottom"><section class="panel"><div class="section-heading"><h2>Ostatnie podejścia</h2><a class="text-link" href="#/history">Pełna historia →</a></div>${historyTable(attempts.slice(0,5),true)}</section><section class="panel growth"><p class="eyebrow">KROK PO KROKU</p><h2>Twoje ostatnie wyniki</h2>${done.length?`<div class="chart" aria-label="Wyniki siedmiu ostatnich podejść">${done.slice(0,7).reverse().map((a,i)=>`<a href="#/attempt/${a.id}" class="chart-column" title="${esc(a.title)}: ${number(a.percentage)}%"><span>${number(a.percentage)}%</span><meter min="0" max="100" value="${a.percentage}" aria-label="${esc(a.title)}: ${number(a.percentage)}%"></meter><small>${new Intl.DateTimeFormat('pl-PL',{day:'numeric',month:'numeric',timeZone:'Europe/Warsaw'}).format(new Date(a.completed_at))}</small></a>`).join('')}</div><p class="muted small">Do 7 ostatnich podejść, od najstarszego. Każdy słupek prowadzi do wyniku.</p>`:'<div class="chart-empty" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><p class="muted">Twój wykres pojawi się po pierwszym teście. Zacznij od tematu, który lubisz.</p>'}</section></div>`, 'Mój pulpit', 'home');
  }

  function subjects() {
    setPage(heading('PIĘĆ ŚCIEŻEK ODKRYWANIA','Wybierz przedmiot','Gotowe zestawy i nowe kombinacje pytań. Bez pośpiechu, z podpowiedziami.')+subjectCards()+`<section class="note-card"><strong>${catalog.topics.length} zagadnień · ${catalog.tests.filter(t=>!t.generated).length} gotowych zestawów · ${catalog.question_count} pytań</strong><p>Wybierz krótki zestaw tematyczny lub diagnozę z całego rozdziału. Możesz też utworzyć własną kombinację 10, 15 lub 20 pytań.</p></section>`,'Przedmioty','subjects');
  }

  function subjectView(id) {
    if (!catalog.subjects[id]) throw new Error('Nie znaleziono przedmiotu.');
    const topics = catalog.topics.filter(t=>t.subject===id), sections=[...new Set(topics.map(t=>t.section))];
    setPage(heading('KLASA 4',subjectName(id),descriptions[id],'<a class="text-link" href="#/subjects">← Przedmioty</a>')+sections.map(section=>`<section class="topic-section"><h2>${esc(section)}</h2><div class="topic-grid">${topics.filter(t=>t.section===section).map(t=>{
      const done=completed().filter(a=>a.topic_id===t.id), best=done.length ? Math.max(...done.map(a=>a.percentage)):null;
      return `<a class="topic-card ${id}" href="#/topic/${t.id}"><span class="subject-symbol" aria-hidden="true">${symbols[id]}</span><div><h3>${esc(t.title)}</h3><p>${esc(t.description)}</p><span class="topic-meta">${counted(catalog.tests.filter(test=>test.topic_id===t.id).length,'zestaw','zestawy','zestawów')} · ${t.question_count} pytań w bazie</span>${done.length?`<div class="topic-progress"><span>${done.length} podejść</span><strong>Najlepszy: ${number(best)}%</strong></div>${progress(best)}`:'<span class="topic-start">Odkryj temat →</span>'}</div></a>`;
    }).join('')}</div></section>`).join(''),subjectName(id),'subjects');
  }

  function topicView(id) {
    const t=topic(id); if (!t) throw new Error('Nie znaleziono zagadnienia.');
    const sets=catalog.tests.filter(s=>s.topic_id===id);
    setPage(heading(esc(subjectName(t.subject)+' / '+t.section),esc(t.title),esc(t.description),`<a class="text-link" href="#/subject/${t.subject}">← ${esc(subjectName(t.subject))}</a>`)+`

      <div class="section-heading"><h2>Wybierz zestaw</h2><span class="muted small">Każde rozpoczęcie tworzy osobne podejście</span></div><div class="sets-grid">${sets.map((s,i)=>{
        const previous=attempts.filter(a=>a.test_id===s.id), done=previous.filter(a=>a.status==='completed'), ongoing=previous.find(a=>a.status==='in_progress');
        return `<article class="set-card"><div class="set-heading"><span class="set-number">${s.generated?'✦':String(i+1).padStart(2,'0')}</span><span class="status-pill ${s.generated?'purple':''}">${s.generated?'Twój zestaw':'Gotowy zestaw'}</span></div><h3>${esc(s.name)}</h3><p>${s.total} pytań · z podpowiedziami</p>${done.length?`<div class="set-record"><span>Ostatnio: <b>${number(done[0].percentage)}%</b></span><span>${done.length} ${done.length===1?'podejście':'podejść'}</span></div>`:'<p class="muted small">Jeszcze nieukończony</p>'}<div class="set-actions">${ongoing?`<a class="button primary" href="#/attempt/${ongoing.id}">Wznów (${ongoing.answered}/${ongoing.total}) →</a>`:''}<button type="button" class="button ${ongoing?'ghost':'primary'}" data-start="${s.id}">${done.length||ongoing?'Nowe podejście':'Zaczynamy'} →</button></div>${done.length?`<a class="text-link small" href="#/attempt/${done[0].id}">Zobacz ostatni wynik</a>`:''}</article>`;
      }).join('')}</div>
      <section class="generator-panel"><div><p class="eyebrow">KOLEJNY KROK</p><h2>Nowy zestaw, nowe podejście</h2><p>Ułóż inną kombinację z ${t.question_count} pytań. Generator w pierwszej kolejności wybiera rzadziej ćwiczone zadania.</p><p class="small muted">Pytania mogą wracać między zestawami. Generator korzysta ze sprawdzonej bazy, bez zewnętrznego AI.</p></div><form id="generator-form" data-topic="${t.id}"><label for="question-count">Liczba pytań</label><select id="question-count" name="count"><option value="10">10 pytań · krótka sesja</option><option value="15">15 pytań</option><option value="20">20 pytań</option></select><button class="button primary" type="submit">＋ Wygeneruj zestaw</button><p id="generator-status" role="status"></p></form></section>`,t.title,'subjects');
  }

  function history() {
    setPage(heading('WSZYSTKO ZOSTAJE Z TOBĄ','Historia wyników','Daty, punkty i procenty z każdego podejścia. Poprawki nie zmieniają tych wyników.','<a class="button secondary" href="/api/export.csv" download>Pobierz CSV ↓</a>')+`
      <form class="filters" id="history-filters"><label>Przedmiot<select name="subject"><option value="">Wszystkie</option>${Object.entries(catalog.subjects).map(([id,name])=>`<option value="${id}" ${historyFilters.subject===id?'selected':''}>${name}</option>`).join('')}</select></label><label>Status<select name="status"><option value="">Wszystkie</option><option value="completed" ${historyFilters.status==='completed'?'selected':''}>Ukończone</option><option value="in_progress" ${historyFilters.status==='in_progress'?'selected':''}>W trakcie</option></select></label><label>Od<input name="from" type="date" value="${esc(historyFilters.from)}"></label><label>Do<input name="to" type="date" value="${esc(historyFilters.to)}"></label><label class="search-label">Szukaj tematu<input name="search" type="search" placeholder="np. ułamki" value="${esc(historyFilters.search)}"></label></form><section class="panel" id="history-list"></section>`,'Historia wyników','history');
    filterHistory();
  }

  function filterHistory() {
    const f=historyFilters;
    const rows=attempts.filter(a=>(!f.subject||a.subject===f.subject)&&(!f.status||a.status===f.status)&&(!f.from||localDay(a.completed_at||a.started_at)>=f.from)&&(!f.to||localDay(a.completed_at||a.started_at)<=f.to)&&(!f.search||(a.title+' '+a.test_name).toLocaleLowerCase('pl').includes(f.search.toLocaleLowerCase('pl'))));
    $('history-list').innerHTML = rows.length ? `<p class="small muted">Podejścia: ${rows.length}</p>`+historyTable(rows) : empty('Brak podejść w tym widoku','Zmień filtry albo rozwiąż nowy test.');
  }

  function mistakes() {
    const needs=completed().filter(a=>a.remaining>0), fixed=completed().reduce((sum,a)=>sum+a.corrected,0);
    setPage(heading('BŁĄD TO POCZĄTEK NAUKI','Poćwicz jeszcze raz','Poprawiaj pojedyncze pytania. Pierwotny wynik zostaje zapisany bez zmian.')+`<div class="practice-summary"><span><strong>${remaining()}</strong> pytań do poprawy</span><span><strong>${fixed}</strong> poprawionych błędów</span></div>`+(needs.length?`<div class="practice-grid">${needs.map(a=>`<article class="panel practice-card">${subjectBadge(a.subject)}<h2>${esc(a.title)}</h2><p>${esc(a.test_name)} · ${date(a.completed_at)}</p><div class="practice-score"><span>Wynik przed poprawkami</span><strong>${a.score}/${a.total} · ${number(a.percentage)}%</strong></div><p><b>${a.remaining}</b> pytań czeka na powtórkę${a.corrected?` · ${a.corrected} już poprawione`:''}</p><a class="button primary" href="#/practice/${a.id}">Poćwicz błędy →</a></article>`).join('')}</div>`:empty('Wszystko przećwiczone!','Po zakończeniu testu znajdziesz tutaj pytania, które wymagają powtórki.','<a href="#/subjects" class="button primary">Przejdź do przedmiotów →</a>')),'Do poprawy','mistakes');
  }

  async function openAttempt(id, version) {
    const data=await api('/attempts/'+id); if(version!==routeVersion)return;
    current=data; position=Math.max(0,data.questions.findIndex(q=>Object.hasOwn(drafts,draftKey(q))||!Object.hasOwn(data.answers,q.id)));
    if(data.status==='completed') results(); else quiz();
  }

  function quiz() {
    const q=current.questions[position], selected=current.answers[q.id], hadHint=current.hints.includes(q.id);
    setPage(`<div class="quiz-shell"><div class="quiz-top"><a class="text-link" href="#/topic/${current.topic_id}">← Wróć do zestawów</a>${subjectBadge(current.subject)}</div><p class="eyebrow">${esc(current.test_name)} · PODEJŚCIE ${current.attempt_number}</p><h1 class="quiz-title">${esc(current.title)}</h1><div class="quiz-progress-label"><b>Pytanie ${position+1} z ${current.total}</b><span>Zapisano: ${Object.keys(current.answers).length} z ${current.total}</span></div>${progress(Object.keys(current.answers).length,current.total)}
      <article class="question-panel"><p class="eyebrow">${typeLabels[questionType(q)]}</p><h2 id="question-text" tabindex="-1">${esc(q.prompt)}</h2>${illustration(q)}${questionType(q)==='choice'?`<div class="choices" role="group" aria-labelledby="question-text">${q.options.map((option,i)=>`<button type="button" class="choice ${selected===option?'selected':''}" aria-pressed="${selected===option}" data-choice="${i}"><span class="choice-letter" aria-hidden="true">${String.fromCharCode(65+i)}</span><span>${esc(option)}</span>${selected===option?'<span class="choice-check" aria-hidden="true">✓</span>':''}</button>`).join('')}</div>`:`<form id="answer-form" data-question="${q.id}">${answerFields(q,drafts[draftKey(q)]??selected)}<p class="small muted">1 punkt za całe poprawnie wykonane zadanie.</p><button type="submit" class="button primary">Zapisz odpowiedź</button><p role="status" class="form-status"></p></form>`}<button class="hint-toggle" id="hint-toggle" type="button" aria-expanded="false" aria-controls="hint-box">✧ Pokaż podpowiedź</button><div id="hint-box" class="hint-box" hidden>${esc(q.hint)}</div><span id="save-status" role="status" class="save-status">${Object.hasOwn(drafts,draftKey(q))?'Odpowiedź robocza w tej przeglądarce — zapisz ją przyciskiem.':Object.hasOwn(current.answers,q.id)?'✓ Odpowiedź zapisana na serwerze':'Oczekujemy na odpowiedź'}${hadHint?' · podpowiedź była użyta':''}</span></article>
      <div class="quiz-navigation"><button class="button secondary" id="previous" ${position===0?'disabled':''}>← Wstecz</button><span class="small muted">Możesz zmienić odpowiedź przed zakończeniem.</span><button class="button primary" id="next">${position===current.total-1?'Zakończ i zapisz wynik':'Dalej →'}</button></div><p class="inline-error" id="quiz-error" role="alert"></p><div class="question-map" aria-label="Przejdź do pytania">${current.questions.map((item,i)=>`<button aria-label="Pytanie ${i+1}${Object.hasOwn(current.answers,item.id)?', odpowiedź zapisana':''}" ${position===i?'aria-current="step"':''} class="${Object.hasOwn(current.answers,item.id)?'answered':''}" data-position="${i}">${i+1}</button>`).join('')}</div><p class="small muted centered">Nie ma limitu czasu. Podpowiedzi nie odejmują punktów.</p></div>`,current.title,'subjects');
  }

  async function saveQuestion(option, hint=false) {
    if(saving)return false;
    const q=current.questions[position], savedVersion=routeVersion, attemptId=current.id; saving=true;
    document.querySelectorAll('.quiz-shell button,.quiz-shell input,.quiz-shell select').forEach(b=>b.disabled=true);
    $('save-status').textContent='Zapisuję na serwerze…';
    try {
      const body={revision:current.revision,question_id:q.id,...(hint?{hint:true}:{answer:option})};
      const updated=await api(`/attempts/${attemptId}/answer`,body);
      if(savedVersion!==routeVersion)return;
      current=updated;if(!hint){delete drafts[draftKey(q)];persistDrafts();}quiz();
      if(hint){$('hint-box').hidden=false;$('hint-toggle').setAttribute('aria-expanded','true');$('hint-toggle').textContent='✧ Ukryj podpowiedź';}
      return true;
    } catch(error) {
      if(savedVersion!==routeVersion)return;
      quiz(); $('quiz-error').textContent=error.message;
      $('save-status').textContent='Ta zmiana nie została potwierdzona. Spróbuj ponownie.';
      if(error.status===409) $('quiz-error').insertAdjacentHTML('beforeend',` <button class="text-link" id="reload-attempt">Wczytaj bieżący zapis</button>`);
      return false;
    } finally { saving=false; }
  }

  function results() {
    const fixed=new Set(current.corrections.filter(c=>c.correct).map(c=>c.question_id));
    setPage(`<div class="result-heading"><div><p class="eyebrow">PODEJŚCIE ${current.attempt_number} ZAPISANE</p><h1>${esc(current.title)}</h1><p class="lead">${esc(current.test_name)} · ${date(current.completed_at)}</p></div>${subjectBadge(current.subject)}</div>
      <section class="result-banner"><div><p>Wynik przed poprawkami</p><div class="big-score">${current.score}<span> / ${current.total}</span></div><span class="result-percent">${number(current.percentage)}%</span></div><div class="result-message"><h2>${current.percentage===100?'Wszystko się zgadza!':current.percentage>=70?'Dobra robota!':'Każda próba czegoś uczy.'}</h2><p>Ten wynik jest już zapisany. Każda poprawka ma osobną datę i nie zmienia punktów z tego podejścia.</p><p class="small">Podpowiedzi: ${current.hints_used} z ${current.total} pytań · poprawione błędy: ${current.corrected}</p><div class="button-row">${current.remaining?`<a class="button primary" href="#/practice/${current.id}">Poćwicz ${counted(current.remaining,'błąd','błędy','błędów')} →</a>`:''}<button class="button secondary" data-start="${current.test_id}">Nowe podejście</button><a class="text-link" href="#/topic/${current.topic_id}">Inny zestaw →</a></div></div></section>
      <div class="section-heading"><h2>Odpowiedzi i wyjaśnienia</h2><a href="#/history" class="text-link">Historia wyników →</a></div><div class="review-list">${current.questions.map((q,i)=>{
        const ok=correctInitially(q), corrections=current.corrections.filter(c=>c.question_id===q.id);
        return `<article class="review-card ${ok?'correct':fixed.has(q.id)?'fixed':'incorrect'}"><div class="review-header"><span class="review-index">${i+1}</span><span class="review-state">${ok?'✓ Poprawnie za pierwszym razem':fixed.has(q.id)?'✓ Błąd przećwiczony':'↺ Do poprawy'}</span></div><h3>${esc(q.prompt)}</h3>${illustration(q)}<p class="answer-line">Twoja pierwsza odpowiedź: <strong>${esc(answerText(q,current.answers[q.id]))}</strong></p>${!ok?`<p class="correct-line">Poprawna odpowiedź: <strong>${esc(answerText(q,q.answer))}</strong></p>`:''}<p>${esc(q.explanation)}</p>${!ok?`<a class="button ${fixed.has(q.id)?'ghost':'secondary'} small" href="#/practice/${current.id}/${q.id}">${fixed.has(q.id)?'Poćwicz ponownie':'Popraw to pytanie'} →</a>`:''}${corrections.length?`<details class="correction-log"><summary>Historia poprawek (${corrections.length})</summary><ul>${corrections.map(c=>`<li><time>${date(c.created_at)}</time> · ${esc(answerText(q,c.selected))} · <b>${c.correct?'poprawnie':'spróbuj ponownie'}</b></li>`).join('')}</ul></details>`:''}</article>`;
      }).join('')}</div>`,'Wynik testu','history');
  }

  async function practice(id, qid, version) {
    const data=await api('/attempts/'+id); if(version!==routeVersion)return;
    current=data;
    if(data.status!=='completed'){location.hash='/attempt/'+id;return;}
    const fixed=new Set(data.corrections.filter(c=>c.correct).map(c=>c.question_id));
    const wrong=data.questions.filter(q=>!correctInitially(q));
    const q=qid ? wrong.find(q=>q.id===qid) : wrong.find(q=>!fixed.has(q.id));
    if(!q){setPage(empty('Wszystkie błędy z tego testu przećwiczone!','Pierwotny wynik pozostał bez zmian.',`<a class="button primary" href="#/attempt/${id}">Wróć do wyniku →</a>`),'Poprawki','mistakes');return;}
    const feedback=correctionFeedback?.qid===q.id&&correctionFeedback?.attempt===id?correctionFeedback:null;
    const next=wrong.find(item=>!fixed.has(item.id)&&item.id!==q.id);
    setPage(`<div class="quiz-shell practice-shell"><div class="quiz-top"><a class="text-link" href="#/attempt/${id}">← Wynik testu</a><span class="status-pill purple">Ćwiczenie błędu</span></div><p class="eyebrow">${esc(data.title)}</p><h1>Spróbuj jeszcze raz</h1><p class="lead">Zapisany wynik: <strong>${data.score}/${data.total} · ${number(data.percentage)}%</strong>. Poprawka go nie zmieni.</p><article class="question-panel"><p class="eyebrow">${typeLabels[questionType(q)]}</p><h2 id="question-text">${esc(q.prompt)}</h2>${illustration(q)}<form id="correction-form" data-question="${q.id}">${answerFields(q,undefined)}<details class="practice-hint"><summary>✧ Podpowiedź</summary><p>${esc(q.hint)}</p></details><button class="button primary" type="submit">Sprawdź poprawkę</button><p id="correction-status" role="status"></p></form>${feedback?`<div class="feedback ${feedback.correct?'success':'retry'}" role="status"><strong>${feedback.correct?'✓ Dobrze! Poprawka została zapisana.':'Jeszcze jeden krok. Ta próba też jest zapisana.'}</strong><p>${feedback.correct?esc(q.explanation):esc(q.hint)}</p></div>`:''}</article><div class="button-row practice-next">${next?`<a class="button secondary" href="#/practice/${id}/${next.id}">Następny błąd →</a>`:`<a class="button secondary" href="#/attempt/${id}">Wróć do wyniku →</a>`}<a class="text-link" href="#/mistakes">Wszystkie powtórki</a></div></div>`,'Poprawka pytania','mistakes');
  }

  function parent() {
    setPage(heading('DOMOWA PRACOWNIA','Ustawienia i materiały','Jeden profil dziecka. Wspólna historia na telefonie, tablecie i komputerze.')+`
      <div class="parent-grid"><section class="panel"><h2>Jak się do Ciebie zwracać?</h2><form id="profile-form"><label for="child-name">Imię lub pseudonim</label><input id="child-name" name="name" maxlength="32" required value="${esc(catalog.profile.name)}"><button class="button primary" type="submit">Zapisz nazwę</button><p id="profile-status" role="status"></p></form></section><section class="panel"><h2>Twoje dane zostają u Ciebie</h2><p>Odpowiedzi i wyniki są zapisywane na domowym serwerze. Możesz kontynuować na innym urządzeniu w tej samej sieci.</p><div class="button-row"><a class="button secondary" href="/api/export.csv" download>Historia CSV ↓</a><a class="button secondary" href="/api/export.json" download>Pełny eksport JSON ↓</a></div><p class="small muted">Kopia bazy powstaje także na serwerze po zapisaniu wyniku, poprawki lub nowego zestawu. Dostęp do profilu mają osoby korzystające z tego adresu w Twojej sieci.</p></section></div>
      <section class="panel content-notes"><h2>Jak działa platforma?</h2><div class="explainer-grid"><article><span>01</span><h3>Każde podejście osobno</h3><p>Wybór jednej odpowiedzi zapisuje się od razu. W pozostałych zadaniach użyj „Zapisz odpowiedź” lub „Dalej”. Zakończony wynik jest niezmienny, nawet po ponownym podejściu.</p></article><article><span>02</span><h3>Poprawka to nauka</h3><p>Próby poprawienia pojedynczego błędu mają własną historię. Nie podnoszą punktów ani procentów pierwotnego podejścia.</p></article><article><span>03</span><h3>Nowe kombinacje</h3><p>Gotowe zestawy tematyczne i diagnozy rozdziałów. Generator układa nowe kombinacje z bazy ${catalog.question_count} autorskich pytań. Nie tworzy nieograniczonej liczby nowych treści.</p></article></div></section>
      <section class="panel content-notes"><h2>Zakres i źródła</h2><p>Podstawą doboru tematów są dokumenty MEN obowiązujące w klasie 4 od września 2026. Część wymagań opisano wspólnie dla klas 4–6; tutaj wybieramy materiał na poziomie początku tego etapu. Kolejność i tempo omawiania tematów ustala nauczyciel.</p><p><strong>Polski:</strong> ortografia, podstawy gramatyki oraz dwie lektury wybrane przez rodzica: „Akademia pana Kleksa” i „Magiczne drzewo. Czerwone krzesło”. Nie przedstawiamy ich jako obowiązkowych tytułów dla każdej klasy 4.</p><p><strong>Angielski:</strong> początek kursu New English Class 4 (Pearson), zaimki i czasownik to be wyłącznie w Present Simple. Diagnozy rozdziału 1 obejmują też słownictwo rodziny, miejsc, krajów i narodowości, apostrof ’s oraz my, your, his, her. <strong>Historia:</strong> wprowadzenie do przedmiotu i początek nowego kursu chronologicznego. <strong>Matematyka:</strong> podstawowe umiejętności klasy 4.</p><p><strong>Przyroda:</strong> dział „Okiem badacza” na podstawie zdjęć przekazanych przez rodzica: przyroda, zmysły, orientacja w terenie, doświadczenia i mikroskop. Pięć rozdziałów, w każdym dwa rozłączne testy po 15 pytań. Pytania oraz schematy są autorskie. Dopasowania, kolejność i zadania z wieloma odpowiedziami dają 1 punkt tylko za całe poprawne zadanie. Krótkie odpowiedzi nie są testem ortografii.</p><details class="source-details"><summary>Dokumenty i materiały źródłowe (${catalog.sources.length})</summary><ul class="source-list">${catalog.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ↗</a>${s.note?`<p>${esc(s.note)}</p>`:''}</li>`).join('')}</ul></details><p class="small muted">Funkcje historii postępów i powtórek inspirowane rozwiązaniami <a href="https://www.ixl.com/analytics" target="_blank" rel="noopener noreferrer">IXL</a> i <a href="https://support.khanacademy.org/hc/en-us/articles/360037494231-What-are-Mastery-Challenges" target="_blank" rel="noopener noreferrer">Khan Academy</a>. Pytania są autorskie.</p></section>
`,'Ustawienia i materiały','parent');
  }

  async function route() {
    const version=++routeVersion;
    notify(''); $('content').setAttribute('aria-busy','true');
    try {
      await refresh(); if(version!==routeVersion)return;
      const parts=(location.hash.slice(1)||'/').split('/').filter(Boolean);
      switch(parts[0]) {
        case undefined: home();break;
        case 'subjects':subjects();break;
        case 'subject':subjectView(parts[1]);break;
        case 'topic':topicView(parts[1]);break;
        case 'history':history();break;
        case 'mistakes':mistakes();break;
        case 'parent':parent();break;
        case 'attempt':await openAttempt(parts[1],version);break;
        case 'practice':await practice(parts[1],parts[2],version);break;
        default:throw new Error('Nie znaleziono tej strony. Wróć do pulpitu.');
      }
      if(version!==routeVersion)return;
      window.scrollTo({top:0,behavior:'instant'});
      $('content').focus({preventScroll:true});
    } catch(error) {
      if(version!==routeVersion)return;
      notify(error.message,true);
      $('content').innerHTML=empty('Nie udało się wczytać strony','Sprawdź połączenie z domową siecią. Zapisane wcześniej odpowiedzi pozostają na serwerze.','<button id="retry-route" class="button primary">Spróbuj ponownie</button>');
    } finally { if(version===routeVersion)$('content').removeAttribute('aria-busy'); }
  }

  $('content').addEventListener('click',async event=>{
    const button=event.target.closest('button'); if(!button||button.disabled)return;
    try {
      if(button.dataset.start){
        button.disabled=true;
        if(!pendingStart||pendingStart.test_id!==button.dataset.start)pendingStart={test_id:button.dataset.start,request_id:uid()};
        const attempt=await api('/attempts',pendingStart);pendingStart=null;location.hash='/attempt/'+attempt.id;
      } else if(button.dataset.move!==undefined){
        const row=button.closest('.order-row'), list=row.parentElement, direction=Number(button.dataset.move);
        if(direction<0&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);
        else if(direction>0&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);
        Array.from(list.children).forEach((item,i)=>{item.querySelector('.order-number').textContent=i+1;item.querySelector('[data-move="-1"]').disabled=i===0;item.querySelector('[data-move="1"]').disabled=i===list.children.length-1;});
        rememberDraft();
      } else if(button.dataset.choice!==undefined){
        await saveQuestion(current.questions[position].options[Number(button.dataset.choice)]);
      } else if(button.dataset.position!==undefined){
        if(saving)return;position=Number(button.dataset.position);quiz();$('question-text').focus({preventScroll:true});
      } else if(button.id==='previous'){
        if(saving)return;position=Math.max(0,position-1);quiz();$('question-text').focus({preventScroll:true});
      } else if(button.id==='next'){
        if(saving)return;
        const q=current.questions[position];
        if(questionType(q)!=='choice'){
          let value;
          try{value=readAnswer(q,$('answer-form'));}catch(error){$('quiz-error').textContent=error.message;return;}
          if(!Object.hasOwn(current.answers,q.id)||JSON.stringify(value)!==JSON.stringify(current.answers[q.id])){
            if(!await saveQuestion(value))return;
          }
          delete drafts[draftKey(q)];persistDrafts();
        }
        if(!Object.hasOwn(current.answers,q.id)){$('quiz-error').textContent='Wybierz jedną odpowiedź przed przejściem dalej.';return;}
        if(position<current.total-1){position++;quiz();$('question-text').focus({preventScroll:true});}
        else{
          const pending=current.questions.findIndex(q=>Object.hasOwn(drafts,draftKey(q)));
          if(pending!==-1){position=pending;quiz();$('quiz-error').textContent='Tu jest jeszcze zmieniona odpowiedź robocza. Zapisz ją przed zakończeniem testu.';return;}
          const missing=current.questions.findIndex(q=>!Object.hasOwn(current.answers,q.id));
          if(missing!==-1){position=missing;quiz();$('quiz-error').textContent='Jeszcze to pytanie czeka na odpowiedź.';return;}
          saving=true;button.disabled=true;button.textContent='Zapisuję wynik…';
          try{current=await api(`/attempts/${current.id}/finish`,{revision:current.revision});await refresh();results();window.scrollTo({top:0,behavior:'instant'});$('content').focus({preventScroll:true});}
          finally{saving=false;}
        }
      } else if(button.id==='hint-toggle'){
        if(!$('hint-box').hidden){$('hint-box').hidden=true;button.setAttribute('aria-expanded','false');button.textContent='✧ Pokaż podpowiedź';}
        else if(current.hints.includes(current.questions[position].id)){$('hint-box').hidden=false;button.setAttribute('aria-expanded','true');button.textContent='✧ Ukryj podpowiedź';}
        else await saveQuestion(undefined,true);
      } else if(button.id==='retry-route'||button.id==='reload-attempt')await route();
    } catch(error){notify(error.message,true);button.disabled=false;if(button.id==='next')button.textContent='Spróbuj zapisać wynik ponownie';}
  });

  $('content').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target, button=form.querySelector('button[type="submit"]');
    if(!button||button.disabled)return;button.disabled=true;
    try{
      if(form.id==='answer-form'){
        const q=current.questions.find(q=>q.id===form.dataset.question);
        await saveQuestion(readAnswer(q,form));
      } else if(form.id==='generator-form'){
        const topic_id=form.dataset.topic,count=Number(new FormData(form).get('count'));
        if(!pendingGeneration||pendingGeneration.topic_id!==topic_id||pendingGeneration.count!==count)pendingGeneration={topic_id,count,request_id:uid()};
        $('generator-status').textContent='Układam zestaw…';
        const result=await api('/generate',pendingGeneration);pendingGeneration=null;await refresh();topicView(topic_id);notify('Nowy zestaw jest gotowy. Znajdziesz go na liście poniżej.');
        const created=document.querySelector(`[data-start="${result.test_id}"]`);created?.scrollIntoView({block:'center'});created?.focus({preventScroll:true});
      } else if(form.id==='profile-form'){
        const result=await api('/profile',{name:new FormData(form).get('name')});catalog.profile.name=result.name;$('profile-name').textContent=result.name;$('profile-status').textContent='Nazwa zapisana.';
      } else if(form.id==='correction-form'){
        const q=current.questions.find(q=>q.id===form.dataset.question), answer=readAnswer(q,form);
        if(!pendingCorrection||pendingCorrection.question_id!==q.id||JSON.stringify(pendingCorrection.answer)!==JSON.stringify(answer)||pendingCorrection.attempt!==current.id)pendingCorrection={question_id:q.id,answer,request_id:uid(),attempt:current.id};
        $('correction-status').textContent='Zapisuję poprawkę…';
        const result=await api(`/attempts/${current.id}/correct`,pendingCorrection);
        correctionFeedback={attempt:current.id,qid:q.id,correct:result.corrections.find(c=>c.request_id===pendingCorrection.request_id).correct};pendingCorrection=null;
        await refresh();await practice(current.id,q.id,routeVersion);
      }
    } catch(error){notify(error.message,true);const status=form.querySelector('[role="status"]');if(status)status.textContent='Zapis nie został potwierdzony. Spróbuj ponownie.';}
    finally{button.disabled=false;}
  });

  $('content').addEventListener('input',event=>{
    if(event.target.closest('#answer-form'))rememberDraft();
    if(event.target.closest('#history-filters')){historyFilters=Object.fromEntries(new FormData($('history-filters')));filterHistory();}
  });
  document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('content').focus();});
  document.addEventListener('click',event=>{if(saving && event.target.closest('a')){event.preventDefault();notify('Trwa zapisywanie odpowiedzi. Poczekaj chwilę.');}},true);
  window.addEventListener('hashchange',route);
  window.addEventListener('offline',()=>notify('Brak połączenia. Przed kolejną odpowiedzią połącz się z domową siecią.',true));
  window.addEventListener('online',()=>notify('Połączenie wróciło. Możesz kontynuować naukę.'));
  route();
})();
