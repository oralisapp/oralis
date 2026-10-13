/* Real Chromium/React regression test. Run with web dev at EDITOR_TEST_URL (default :3000). API responses are intercepted. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const shared = require('../packages/shared/dist');
const base = process.env.EDITOR_TEST_URL || 'http://localhost:3000';
const output = path.resolve('.data/ui-review');
fs.mkdirSync(output, { recursive: true });
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-sandbox', '--in-process-gpu', '--disable-gpu', '--disable-software-rasterizer', '--remote-debugging-port=9337', `--user-data-dir=${output}/clinical-test-profile`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws;
(async () => {
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9337/json')).json(); break; } catch { await pause(200); } }
  assert(targets, 'Chrome debugging endpoint');
  ws = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let seq = 0; const pending = new Map(); const puts = []; const errors = []; let held = []; let holding = true; let finalizedVersion; let finalizeRequest;
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const until = async fn => { const started = Date.now(); while (Date.now() - started < 90000) { try { if (await fn()) return; } catch (error) { if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error; } await pause(100); } throw Error('Timed out: ' + fn); };
  const fulfill = (id, data) => call('Fetch.fulfillRequest', { requestId: id, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') });
  const org = '11111111-1111-4111-8111-111111111111', unit = '22222222-2222-4222-8222-222222222222';
  const backupKey = `oralis.draft.${org}.user-1.record-1`;
  const record = { id: 'record-1', content: '', procedures: [], version: 1, updatedAt: new Date().toISOString(), status: 'draft', authorUserId: 'user-1' };
  const me = { user: { id: 'user-1', name: 'Teste', email: 'editor@example.test', mfaEnabled: true }, memberships: [{ membershipId: 'member-1', organizationId: org, organizationName: 'Teste', role: { key: 'owner', name: 'Proprietária' }, permissions: Object.keys(shared.PERMISSIONS), allUnits: true, units: [{ id: unit, name: 'Centro', timezone: 'America/Manaus' }], subscription: { status: 'active', access: 'full', features: [] } }] };
  const workspace = { appointment: { id: 'visit-1', status: 'in_progress', startsAt: new Date().toISOString(), endsAt: new Date().toISOString(), version: 1, unitId: unit, unitName: 'Centro', timezone: 'America/Manaus', professionalName: 'Dra. Teste', isOwn: true }, patient: { id: 'patient-1', fullName: 'Paciente Teste', birthDate: null }, encounter: { id: 'encounter-1' }, records: [record], othersDrafting: false, previous: [], alerts: [], anamnesis: { latest: null, pendingPatientResponse: null, historyCount: 0 }, documents: [], treatmentItems: [], canWrite: true };
  ws.addEventListener('message', async event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method !== 'Fetch.requestPaused') return;
    const { request, requestId } = m.params; const u = new URL(request.url); let data = [];
    if (u.pathname.endsWith('/auth/me')) data = me;
    else if (u.pathname.endsWith('/workspace')) data = workspace;
    else if (u.pathname.endsWith('/onboarding')) data = { steps: [], requiredDone: 4, requiredTotal: 4 };
    else if (request.method === 'PUT' && u.pathname.endsWith('/clinical-records/record-1')) { const body = JSON.parse(request.postData); puts.push(body); if (holding) { held.push({ requestId, body }); return; } record.version = body.version + 1; record.content = body.content; data = { version: record.version, updatedAt: new Date().toISOString() }; }
    else if (u.pathname.endsWith('/finalize')) { finalizedVersion = JSON.parse(request.postData).version; finalizeRequest = requestId; return; }
    await fulfill(requestId, data);
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  const clean = await call('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.clear();' });
  await call('Page.navigate', { url: base + '/app/atendimentos/visit-1' });
  await until(() => evaluate("!!document.querySelector('textarea[id=ev-record-1]')"));
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: clean.identifier });
  const type = async text => { await evaluate("document.querySelector('textarea[id=ev-record-1]').focus()"); await call('Input.insertText', { text }); };
  await type('Primeira edição');
  await until(() => puts.length === 1);
  await type(' e segunda edição');
  assert.equal(puts.length, 1, 'no parallel PUT');
  const first = held.shift(); record.version = 2; record.content = first.body.content;
  await fulfill(first.requestId, { version: 2, updatedAt: new Date().toISOString() });
  await until(() => puts.length === 2);
  assert.equal(puts[1].version, 2);
  assert.match(puts[1].content, /segunda edição/);
  assert.match(await evaluate(`localStorage.getItem(${JSON.stringify(backupKey)})`), /segunda edição/, 'new draft remains backed up while second PUT is pending');
  holding = false; const second = held.shift(); record.version = 3; record.content = second.body.content;
  await fulfill(second.requestId, { version: 3, updatedAt: new Date().toISOString() });
  await until(() => evaluate("document.body?.innerText.includes('Rascunho salvo') === true"));
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(backupKey)})`), null);
  await type(' terceira edição');
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Revisar e finalizar').click()");
  await until(() => evaluate("!!document.querySelector('dialog[open]')"));
  await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Finalizar registro').click()");
  await until(() => finalizedVersion !== undefined);
  assert.equal(finalizedVersion, 4, 'finalization uses actual PUT version');
  assert.equal(await evaluate("document.querySelector('textarea[id=ev-record-1]').matches(':disabled')"), true, 'editor stays disabled while finalization request is pending');
  assert.equal(await evaluate("[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent==='Voltar a editar').disabled"), true, 'cannot resume editing during finalization');
  await fulfill(finalizeRequest, {ok:true});
  await until(() => evaluate("!!document.querySelector('textarea[id=ev-record-1]') && !document.querySelector('dialog[open]')"));
  // Recovery survives refresh, is isolated from another user, and is never auto-applied.
  await evaluate(`localStorage.setItem(${JSON.stringify(backupKey)}, JSON.stringify({content:'Rascunho recuperável',procedures:[],baseVersion:4,at:Date.now()}));localStorage.setItem('oralis.draft.${org}.other-user.record-1', JSON.stringify({content:'Segredo outro usuário',procedures:[],baseVersion:4,at:Date.now()}))`);
  // Do not let a matching notice in the old document satisfy the post-reload wait.
  const reloaded = await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__clinicalReloadReady = true;' });
  await call('Page.reload');
  await until(() => evaluate("window.__clinicalReloadReady === true && document.readyState !== 'loading' && !!document.querySelector('textarea[id=ev-record-1]') && document.body?.innerText.includes('Há uma edição não salva') === true"));
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: reloaded.identifier });
  assert.equal(await evaluate("document.body?.innerText.includes('Segredo outro usuário')"), false);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Recuperar edição').click()");
  assert.equal(await evaluate("document.querySelector('textarea').value"), 'Rascunho recuperável');
  await evaluate("window.confirm=()=>false;document.querySelector('a[href=\"/app/visao-geral\"]').click()");
  assert.equal(await evaluate('location.pathname'), '/app/atendimentos/visit-1', 'cancelled navigation remains on workspace');
  assert.deepEqual(errors, []);
  const result = { passed: ['serialized saves', 'backup preserved during edits', 'returned finalization version', 'editing blocked during pending finalization', 'scoped explicit recovery', 'cancel navigation'], puts: puts.length, runtimeErrors: errors };
  fs.writeFileSync(path.join(output, 'clinical-editor-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { ws?.close(); chrome.kill(); });
