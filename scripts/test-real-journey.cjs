/* Real browser → Next proxy → Nest API → PostgreSQL. No intercepted responses.
 * Requires npm run dev. Creates a new synthetic tenant; never truncates data.
 * Provider delivery is never requested. Results contain identifiers, no tokens.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const assert = require('node:assert/strict');
const { CSRF_HEADER } = require('../packages/shared/dist');
const root = path.resolve(__dirname, '..');
process.loadEnvFile(path.join(root, '.env'));
assert(['development', 'test'].includes(process.env.APP_ENV || 'development'), 'Only development/test');
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'Only local database');
const origin = process.env.E2E_ORIGIN || 'http://localhost:3000';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Only local web');
assert(!process.env.SMTP_URL && !process.env.TWILIO_ACCOUNT_SID, 'Use an environment without messaging provider credentials');
const runId = randomUUID();
const output = path.join(root, '.data', 'real-journey', runId);
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [], requests = [];
const report = { runId, startedAt: new Date().toISOString(), mode: 'real-api-postgresql', results, errors, requests };
let chrome, ws, seq = 0;
const pending = new Map();
let call, ev;

async function main() {
  assert.equal((await fetch(origin + '/api/health/ready')).status, 200, 'Real database readiness');
  const port = 9351;
  chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(output, 'browser')}`,
    '--headless=new', '--no-sandbox', '--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--no-first-run', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  chrome.on('error', e => errors.push(e.message));
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (target) break;
    await pause(200);
  }
  assert(target, 'Chrome debugging target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: e => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.responseReceived' && m.params.response.url.startsWith(origin + '/api/')) {
      const u = new URL(m.params.response.url);
      requests.push({ path: u.pathname, status: m.params.response.status });
    }
  });
  ev = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression, label = expression) => {
    for (let i = 0; i < 240; i++) { if (await ev(`Boolean(${expression})`).catch(() => false)) return; await pause(250); }
    const fields = await ev(`Array.from(document.querySelectorAll('dialog[open] input, dialog[open] select')).filter(e => e.type !== 'password').map(e => ({label:e.getAttribute('aria-label') || e.id, value:e.value, tag:e.tagName}))`);
    throw Error(`Timeout: ${label}\n${await ev('document.body.innerText')}\nCampos: ${JSON.stringify(fields)}`);
  };
  const click = async text => {
    const selector = `Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled && e.getClientRects().length)`;
    await wait(`!!(${selector})`, `Button ${text}`);
    await ev(`(${selector}).click()`);
  };
  const fill = async (label, value) => {
    const expr = `(() => { const l = Array.from(document.querySelectorAll('label')).find(l => l.childNodes[0]?.textContent.trim() === ${JSON.stringify(label)}); return l ? document.getElementById(l.htmlFor) : document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); })()`;
    await wait(`(() => { const e = ${expr}; return e && e.getClientRects().length && !e.disabled && (!e.closest('dialog') || e.closest('dialog').open) && Object.keys(e).some(k => k.startsWith('__reactProps$')); })()`, `Visible hydrated field ${label}`);
    await ev(`(() => { const e = ${expr}; e.focus(); e.select(); })()`);
    await call('Input.insertText', { text: value });
  };
  const navigate = async route => { await call('Page.navigate', { url: origin + route }); };
  const api = async (method, route, body) => {
    const r = await ev(`(async () => { const r = await fetch(${JSON.stringify('/api' + route)}, {method: ${JSON.stringify(method)}, headers: {'Content-Type':'application/json', ${JSON.stringify(CSRF_HEADER)}:'1'}, ${body === undefined ? '' : `body: JSON.stringify(${JSON.stringify(body)}),`} credentials:'same-origin'}); return {status:r.status, data:await r.json()}; })()`);
    assert(r.status >= 200 && r.status < 300, `${method} ${route}: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const shot = async name => { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(r.data, 'base64')); };
  await call('Runtime.enable'); await call('Page.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate('/criar-conta?plano=rede');
  await fill('Seu nome', 'Profissional E2E');
  await fill('E-mail', `e2e-${runId}@example.test`);
  await fill('Senha', `E2E-local-${randomUUID()}`);
  await click('Criar conta');
  await wait(`location.pathname === '/onboarding' && document.body.innerText.includes('Nome da clínica')`);
  await fill('Nome da clínica', 'Clínica sintética E2E ' + runId.slice(0, 8));
  await click('Criar clínica e continuar');
  await wait(`location.pathname === '/app/visao-geral' && document.body.innerText.includes('Visão geral')`);
  const me = await api('GET', '/auth/me');
  const membership = me.memberships[0], orgId = membership.organizationId, unitId = membership.units[0].id;
  report.organizationId = orgId;
  const url = p => `/orgs/${orgId}${p}`;
  // Fixtures use the real API from the browser; user-facing journey below uses forms.
  const prof = await api('POST', url('/professionals'), { displayName: 'Dra. E2E', membershipId: membership.membershipId, color: '#0f766e', unitIds: [unitId] });
  // Ensure every execution day has office hours without changing another tenant.
  const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, opensAt: '00:00', closesAt: '23:59' }));
  await api('PUT', url(`/units/${unitId}/hours`), hours);
  results.push('Cadastro e onboarding pela interface, persistidos na API real');

  await navigate('/app/pacientes?novo=1');
  await fill('Nome completo', 'Paciente Sintético E2E');
  await fill('E-mail', `patient-${runId}@example.test`);
  await click('Cadastrar paciente');
  await wait(`!document.querySelector('dialog[open]') && document.body.innerText.includes('Paciente Sintético E2E')`);
  const list = await api('GET', url('/patients?q=Paciente%20Sint%C3%A9tico%20E2E'));
  const patientId = list.items[0].id;
  report.patientId = patientId;
  results.push('Paciente cadastrado na interface e encontrado no banco pela API');

  const tz = membership.units[0].timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const slot = new Date(Date.now() + 2 * 60_000); slot.setSeconds(0, 0);
  const slotDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(slot);
  assert.equal(slotDay, today, 'Run the journey before the final minutes of the clinic day');
  const appt = await api('POST', url('/appointments'), { unitId, patientId, professionalId: prof.id, startsAt: slot.toISOString(), durationMinutes: 5 });
  await navigate(`/app/agenda?data=${today}&consulta=${appt.id}&unidade=${unitId}`);
  await click('Confirmar presença');
  await wait(`!!document.querySelector('dialog[open]') && !Array.from(document.querySelectorAll('dialog[open] button')).some(e => e.textContent.trim() === 'Confirmar presença')`, 'Confirmation persisted and rendered');
  await click('Fazer check-in');
  await wait(`Array.from(document.querySelectorAll('dialog[open] button')).some(e => e.textContent.trim() === 'Iniciar atendimento')`, 'Check-in persisted and rendered');
  await click('Iniciar atendimento');
  await wait(`location.pathname === '/app/atendimentos/${appt.id}' && !!document.querySelector('textarea[id^="ev-"]')`);
  await fill('Evolução da sessão', 'Registro sintético da jornada integrada. Sem dados clínicos reais.');
  await click('Revisar e finalizar'); await click('Finalizar registro');
  await wait(`!document.querySelector('dialog[open]') && !document.querySelector('textarea[id^="ev-"]')`);
  await click('Concluir atendimento'); await click('Concluir');
  await wait(`!document.querySelector('dialog[open]') && document.body.innerText.includes('Concluído')`);
  const workspace = await api('GET', url(`/appointments/${appt.id}/workspace`));
  assert.equal(workspace.appointment.status, 'completed');
  assert.equal(workspace.records[0].status, 'finalized');
  assert(workspace.records[0].contentHash);
  results.push('Confirmação, check-in, atendimento, evolução finalizada e conclusão pela interface');
  await shot('atendimento-finalizado');

  const plan = await api('POST', url(`/patients/${patientId}/treatment-plans`), { unitId, title: 'Plano sintético E2E' });
  await api('POST', url(`/treatment-plans/${plan.id}/items`), { description: 'Procedimento sintético', unitPrice: '100.00' });
  const quote = await api('POST', url(`/treatment-plans/${plan.id}/present`), { installments: 1, method: 'pix', firstDueDate: today, validUntil: today });
  await api('POST', url(`/quotes/${quote.quoteId}/decision`), { versionId: quote.versionId, decision: 'approved', generateReceivables: true });
  await navigate(`/app/pacientes/${patientId}?aba=financeiro`);
  await click('Financeiro');
  await click('Registrar recebimento');
  await wait(`Array.from(document.querySelectorAll('dialog[open] select')).some(e => e.value && e.textContent.includes('Caixa')) && !!document.querySelector('dialog[open] input[aria-label^="Valor para"]')`, 'Cash account and allocation loaded');
  await fill('Valor recebido (R$)', '100,00');
  await wait(`!!Array.from(document.querySelectorAll('dialog[open] button')).find(e => e.textContent.startsWith('Registrar R$') && !e.disabled)`);
  await ev(`Array.from(document.querySelectorAll('dialog[open] button')).find(e => e.textContent.startsWith('Registrar R$') && !e.disabled).click()`);
  await wait(`!document.querySelector('dialog[open]') && document.body.innerText.includes('Paga')`);
  const recs = await api('GET', url(`/finance/receivables?patientId=${patientId}`));
  assert.equal(recs[0].balance, '0.00');
  assert.equal(recs[0].status, 'paid');
  results.push('Orçamento aprovado via API e recebimento pela interface, com saldo zerado');
  await shot('financeiro-pago');

  await navigate('/app/estoque');
  await click('Novo material');
  await fill('Nome', 'Material sintético E2E');
  await fill('Unidade de medida (un, ml, caixa…)', 'un');
  await click('Salvar');
  await wait(`!document.querySelector('dialog[open]') && document.body.innerText.includes('Material sintético E2E')`);
  const items = await api('GET', url(`/inventory/items?unitId=${unitId}`));
  assert(items.some(i => i.name === 'Material sintético E2E'));
  await shot('estoque');
  await navigate('/app/laboratorios');
  await click('Cadastrar laboratório');
  await fill('Nome', 'Laboratório sintético E2E');
  await click('Salvar');
  await wait(`!document.querySelector('dialog[open]') && document.body.innerText.includes('Laboratório sintético E2E')`);
  const labs = await api('GET', url('/labs'));
  assert(labs.some(l => l.name === 'Laboratório sintético E2E'));
  await shot('laboratorios');
  results.push('Material de estoque e laboratório cadastrados pelas novas telas e persistidos na API');

  const link = await api('POST', url(`/patients/${patientId}/portal-link`), { sendEmail: false });
  const portalUrl = new URL(link.url);
  await navigate(portalUrl.pathname + portalUrl.search);
  await wait(`location.pathname === '/paciente/inicio' && document.body.innerText.includes('Paciente')`);
  await navigate('/paciente/pagamentos');
  await wait(`document.body.innerText.includes('100,00')`);
  const payments = await api('GET', '/portal/payments');
  assert.equal(payments.balance, '0.00');
  assert.equal(payments.receivables[0].status, 'paid');
  results.push('Portal acessado com link real de uso único, sem envio de e-mail; cobrança paga conferida');
  await shot('portal-pagamentos');
  assert.equal(errors.length, 0, errors.join('\n'));
  report.passed = true;
}

main().catch(async e => {
  report.passed = false; errors.push(e.message);
  if (call) { try { const r = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'failure.png'), Buffer.from(r.data, 'base64')); } catch {} }
  console.error(e.message); process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  ws?.close(); chrome?.kill();
  console.log(`Real journey: ${results.length} etapas; resultado em ${path.relative(root, output)}/results.json`);
});
