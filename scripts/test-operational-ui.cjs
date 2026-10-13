/* Deterministic browser regression. Every /api request is fulfilled locally. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const assert = require('node:assert/strict');
const shared = require('../packages/shared/dist');
const root = path.resolve(__dirname, '../.data/ui-review');
const port = 9340;
const org = '11111111-1111-4111-8111-111111111111', unit = '22222222-2222-4222-8222-222222222222', second = '22222222-2222-4222-8222-222222222223';
const patient = '33333333-3333-4333-8333-333333333333', appointment = '44444444-4444-4444-8444-444444444444';
const day = '2030-03-19', professional = 'professional-1';
const a = { id: appointment, unitId: second, startsAt: `${day}T13:00:00Z`, endsAt: `${day}T13:30:00Z`, status: 'scheduled', version: 1, patientId: patient, patientName: 'Paciente Simulado', patientSocialName: null, patientPhone: '92999999999', professionalId: professional, chairId: null, serviceId: null, serviceName: null, notes: null, cancellationReason: null, arrivedAt: null, seriesId: null, treatmentItemId: null };
const me = { user: { id: 'user', name: 'Teste operacional', email: 'ui@example.test', mfaEnabled: true }, memberships: [{ membershipId: 'member', organizationId: org, organizationName: 'Clínica de teste', isDemo: false, mfaRequired: false, role: { id: 'role', key: 'owner', name: 'Gestor' }, permissions: Object.keys(shared.PERMISSIONS), allUnits: true, units: [{ id: unit, name: 'Centro', timezone: 'America/Manaus' }, { id: second, name: 'Norte', timezone: 'America/Manaus' }], professionalId: null, subscription: { status: 'active', planName: 'Pro', features: ['crm'], access: 'full', accessReason: '', trialEndsAt: null } }] };
const errors = [], requests = [], results = [];
let chrome, ws, seq = 0;
const pending = new Map();
async function main() {
  fs.mkdirSync(root, { recursive: true });
  await fetch('http://localhost:3000/entrar').then(r => assert.equal(r.status, 200));
  chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'operational-browser')}`, '--headless=new', '--no-sandbox', '--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--no-first-run', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
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
    if (u.pathname.endsWith('/auth/me')) data = me;
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
  await navigate(`/app/agenda?data=${day}&consulta=${appointment}&unidade=${second}`);
  await wait(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').innerText.includes('Paciente Simulado')`);
  assert(requests.some(r => r.path.includes(`/agenda?unitId=${second}&date=${day}`))); results.push('Deep link selected unit, date and appointment');
  await ev(`document.querySelector('dialog[open] button[aria-label="Fechar"]').click()`);
  await wait(`document.body.innerText.includes('Oportunidades para preencher o dia')`);
  await ev(`Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('60 min')).click()`);
  await wait(`document.body.innerText.includes('Candidata da espera')`); await shot('operational-agenda');
  await click('Agendar'); await wait(`document.body.innerText.includes('Paciente da lista de espera agendado')`);
  assert(requests.some(r => r.method === 'POST' && r.body?.includes('waitlistEntryId'))); results.push('Waitlist candidate booked through simulated API');
  await navigate('/app/financeiro'); await wait(`document.body.innerText.includes('Saldo previsto no período')`); await shot('operational-finance');
  await ev(`Array.from(document.querySelectorAll('p')).find(x => x.textContent === 'Vencido em aberto').parentElement.querySelector('button').click()`);
  await wait(`location.search.includes('status=overdue')`); await wait(`document.body.innerText.includes('Nada por aqui')`);
  assert(requests.some(r => r.path.includes('/receivables?status=overdue'))); results.push('Overdue metric opens real receivable filter');
  await navigate('/app/relacionamento?aba=comunicacoes'); await wait(`document.body.innerText.includes('Histórico simulado')`);
  await ev(`const s=document.querySelector('select[aria-label="Situação da comunicação"]'); s.value='blocked_consent'; s.dispatchEvent(new Event('change',{bubbles:true}));`);
  await wait(`document.querySelector('select[aria-label="Situação da comunicação"]').value === 'blocked_consent'`);
  await wait(`document.body.innerText.includes('Paciente Simulado')`);
  await ev(`Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Paciente Simulado')).click()`);
  await ev(`const modelSelect=document.querySelector('select[aria-label="Modelo"]'); modelSelect.value='template-1'; modelSelect.dispatchEvent(new Event('change',{bubbles:true}));`);
  await wait(`document.body.innerText.includes('Mensagem simulada')`);
  assert(await ev(`Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim()==='Enviar').disabled`));
  assert(requests.some(r => r.path.includes('status=blocked_consent'))); assert(!requests.some(r => r.path.endsWith('/messaging/send')));
  await shot('operational-communications'); results.push('History filter and consent block verified without messages');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await shot('operational-communications-mobile');
  assert(!(await ev('document.documentElement.scrollWidth > innerWidth')), 'Mobile page overflow');
  assert.deepEqual(errors, []); fs.writeFileSync(path.join(root, 'operational-results.json'), JSON.stringify({ completed: true, results, errors, requestCount: requests.length }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2)); await call('Browser.close');
}
main().catch(e => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'operational-results.json'), JSON.stringify({ completed: false, results, errors, error: String(e) }, null, 2)); console.error(e); process.exitCode = 1; }).finally(() => { ws?.close(); chrome?.kill(); setTimeout(() => process.exit(process.exitCode || 0), 500).unref(); });
