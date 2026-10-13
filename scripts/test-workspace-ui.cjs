/* Deterministic browser regression. Every /api request is fulfilled locally. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const assert = require('node:assert/strict');
const shared = require('../packages/shared/dist');
const root = path.resolve(__dirname, '../.data/ui-review');
const port = 9341;
const org = '11111111-1111-4111-8111-111111111111', unit = '22222222-2222-4222-8222-222222222222', second = '22222222-2222-4222-8222-222222222223';
const patient = '33333333-3333-4333-8333-333333333333', appointment = '44444444-4444-4444-8444-444444444444';
const day = '2030-03-19', professional = 'professional-1';
const a = { id: appointment, unitId: second, startsAt: `${day}T13:00:00Z`, endsAt: `${day}T13:30:00Z`, status: 'scheduled', version: 1, patientId: patient, patientName: 'Paciente Simulado', patientSocialName: null, patientPhone: '92999999999', professionalId: professional, chairId: null, serviceId: null, serviceName: null, notes: null, cancellationReason: null, arrivedAt: null, seriesId: null, treatmentItemId: null };
const me = { user: { id: 'user', name: 'Teste operacional', email: 'ui@example.test', mfaEnabled: true }, memberships: [{ membershipId: 'member', organizationId: org, organizationName: 'Clínica de teste', isDemo: false, mfaRequired: false, role: { id: 'role', key: 'owner', name: 'Gestor' }, permissions: Object.keys(shared.PERMISSIONS), allUnits: true, units: [{ id: unit, name: 'Centro', timezone: 'America/Manaus' }, { id: second, name: 'Norte', timezone: 'America/Manaus' }], professionalId: null, subscription: { status: 'active', planName: 'Pro', features: ['crm'], access: 'full', accessReason: '', trialEndsAt: null } }] };
const errors = [], requests = [], results = [];
let role = 'reception';
const roles = {
 reception: ['patients.read','schedule.read','schedule.write','crm.read'],
 finance: ['finance.read','finance.write'],
 professional: ['patients.read','schedule.read','clinical.read','clinical.write'],
};
let chrome, ws, seq = 0;
const pending = new Map();
async function main() {
  fs.mkdirSync(root, { recursive: true });
  await fetch('http://localhost:3000/entrar').then(r => assert.equal(r.status, 200));
  chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'workspace-browser')}`, '--headless=new', '--no-sandbox', '--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--no-first-run', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await pause(250); }
  const target = targets?.find(t => t.type === 'page'); assert(target, 'Chrome debugging target');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async expression => { for (let i = 0; i < 240; i++) { try { if (await ev(expression)) return; } catch {} await pause(250); } throw Error(`Timeout: ${expression}\n${await ev('document.body.innerText')}`); };
  const click = async text => { await wait(`Array.from(document.querySelectorAll('button,a')).some(x => x.textContent.trim() === ${JSON.stringify(text)})`); await ev(`Array.from(document.querySelectorAll('button,a')).find(x => x.textContent.trim() === ${JSON.stringify(text)}).click()`); };
  const navigate = route => call('Page.navigate', { url: `http://localhost:3000${route}` });
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(root, `${name}.png`), Buffer.from(r.data, 'base64')); };
  ws.addEventListener('message', async e => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method !== 'Fetch.requestPaused') return;
    const p = m.params, u = new URL(p.request.url); requests.push({ path: u.pathname + u.search, method: p.request.method, body: p.request.postData });
    let data = [], status = 200;
    if (u.pathname.endsWith('/auth/me')) { data = structuredClone(me); data.memberships[0].permissions = roles[role]; data.memberships[0].role = {id:'role',key:role,name:role}; data.memberships[0].professionalId = role === 'professional' ? professional : null; }
    else if (u.pathname.endsWith('/clinical/pending-drafts')) data = [{id:'draft-1',patientId:patient,patientName:'Paciente com rascunho',updatedAt:day+'T13:00:00Z',appointmentId:appointment}];
    else if (u.pathname.endsWith('/search')) data = u.searchParams.get('q') === 'zzz' ? {patients:[],appointments:[]} : {patients:[{id:patient,title:'Paciente Simulado',href:'/app/pacientes/'+patient}],appointments:[{id:appointment,patientName:'Paciente Simulado',patientSocialName:null,startsAt:a.startsAt,timezone:'America/Manaus',unitName:'Norte',professionalName:'Dra. Teste',href:'/app/agenda?data='+day+'&consulta='+appointment+'&unidade='+second}]};
    else if (u.pathname.endsWith('/agenda')) data = { unit: me.memberships[0].units.find(x => x.id === u.searchParams.get('unitId')), date: u.searchParams.get('date'), businessHours: [{ weekday: 2, opensAt: '08:00', closesAt: '18:00' }], professionals: [{ id: professional, displayName: 'Dra. Teste', color: '#548a63', membershipId: null, specialties: [] }], chairs: [], services: [], appointments: [a], blocks: [], serverNow: `${day}T12:00:00Z` };
    else if (u.pathname.endsWith(`/appointments/${appointment}`)) data = { appointment: a, history: [] };
    else if (u.pathname.endsWith('/agenda/open-slots')) data = { slots: [{ professionalId: professional, startsAt: `${day}T14:00:00Z`, endsAt: `${day}T15:00:00Z`, minutes: 60 }], professionals: [{ id: professional, displayName: 'Dra. Teste' }] };
    else if (u.pathname.endsWith('/waitlist/suggestions')) data = [{ entryId: 'wait-1', patientId: patient, patientName: 'Candidata da espera', patientPhone: null, durationMinutes: 30, serviceId: null, reasons: ['Duração compatível', 'Profissional disponível'] }];
    else if (u.pathname.endsWith('/appointments') && p.request.method === 'POST') data = { id: 'booked' };
    else if (u.pathname.endsWith('/reports/summary')) data = Object.fromEntries(['contracted', 'charged', 'received', 'recognized', 'overdueBalance', 'openBalance', 'expensesPaid', 'cashResult'].map(k => [k, { value: '100.00', definition: 'Valor simulado' }]));
    else if (u.pathname.endsWith('/reports/cashflow')) data = [{ date: day, expectedIn: '300.00', expectedOut: '100.00', actualIn: '0.00', actualOut: '0.00' }];
    else if (u.pathname.endsWith('/messaging/templates')) data = [{ id: 'template-1', name: 'Retorno', category: 'relationship', channel: 'email', subject: 'Olá', body: 'Mensagem de teste', version: 1 }];
    else if (u.pathname.endsWith('/messaging/preview')) data = { subject: 'Olá', body: 'Mensagem simulada', consent: false, channelConfigured: true };
    else if (u.pathname.endsWith('/messaging/events')) data = [{ e: { id: 'event-1', channel: 'email', category: 'relationship', status: 'blocked_consent', statusDetail: null, subject: null, body: 'Histórico simulado', createdAt: `${day}T12:00:00Z` }, patientName: 'Paciente Simulado', sentByName: 'Equipe', templateName: 'Retorno' }];
    else if (u.pathname.endsWith('/patients')) data = { items: [{ id: patient, fullName: 'Paciente Simulado', socialName: null }], total: 1, page: 1, pageSize: 20 };
    else if (u.pathname.endsWith('/onboarding')) data = { steps: [], requiredDone: 1, requiredTotal: 1 };
    else if (u.pathname.endsWith('/agenda/range')) data = { appointments: [], blocks: [], professionals: [] };
    if (u.pathname.endsWith('/messaging/send')) { errors.push('Unexpected message send attempt'); status = 403; }
    try { await call('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }); } catch (e) { errors.push(e.message); }
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true; localStorage.clear();' });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate('/app/visao-geral');
  await wait(`document.body.innerText.includes('Prioridades da recepção')`);
  assert(!(await ev(`document.body.innerText.includes('Prioridades financeiras')`)));
  await shot('workspace-reception'); results.push('Reception priorities shown without financial/clinical cards');
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',modifiers:2,windowsVirtualKeyCode:75});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'k',code:'KeyK',modifiers:2,windowsVirtualKeyCode:75});
  await wait(`!!document.querySelector('dialog[open] input[aria-label="Buscar área"]')`);
  await ev(`document.querySelector('dialog[open] input').focus()`); await call('Input.insertText',{text:'Paciente'});
  await wait(`document.querySelector('dialog[open]').innerText.toLowerCase().includes('consultas · mais recentes')`);
  assert(await ev(`!!document.querySelector('dialog[open] a[href="/app/pacientes/${patient}"]')`));
  await shot('workspace-search');
  await ev(`document.querySelector('dialog[open] a[href*="consulta="]').click()`);
  await wait(`location.pathname==='/app/agenda' && !!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').innerText.includes('Paciente Simulado')`);
  results.push('Ctrl+K returns patient and appointment; appointment opens matching detail');
  role='finance'; await navigate('/app/visao-geral');
  await wait(`document.body.innerText.includes('Prioridades financeiras') && document.body.innerText.includes('Saldo vencido')`);
  assert(!(await ev(`document.body.innerText.includes('Prioridades da recepção') || document.body.innerText.includes('Evoluções para finalizar')`)));
  await shot('workspace-finance');
  await ev(`Array.from(document.querySelectorAll('a')).find(x=>x.textContent.includes('Saldo vencido')).click()`);
  await wait(`location.search.includes('status=overdue') && document.body.innerText.includes('Nada por aqui')`);
  assert(requests.some(r=>r.path.includes('/receivables?status=overdue')));
  results.push('Finance role excludes reception/clinical priorities; overdue link queries overdue receivables');
  role='professional'; await navigate('/app/visao-geral');
  await wait(`document.body.innerText.includes('Evoluções para finalizar') && document.body.innerText.includes('Paciente com rascunho')`);
  assert(await ev(`!!document.querySelector('a[href="/app/atendimentos/${appointment}"]')`));
  assert(!(await ev(`document.body.innerText.includes('Prioridades financeiras') || document.body.innerText.includes('Prioridades da recepção')`)));
  await shot('workspace-professional'); results.push('Professional sees own pending drafts with appointment links');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await shot('workspace-professional-mobile'); assert(!(await ev('document.documentElement.scrollWidth > innerWidth')));
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(root, 'workspace-results.json'), JSON.stringify({ completed: true, results, errors, requestCount: requests.length }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2)); await call('Browser.close');
}
main().catch(e => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'workspace-results.json'), JSON.stringify({ completed: false, results, errors, error: String(e) }, null, 2)); console.error(e); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); setTimeout(() => process.exit(process.exitCode || 0), 500).unref(); });
