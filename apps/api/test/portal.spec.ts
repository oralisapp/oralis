import { CSRF_HEADER } from '@oralis/shared';
import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { emailMessages } from '../src/db/schema';
import { type Client, type Clinic, type TestContext, addMember, at, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

/** Cliente do portal: cookie próprio do paciente, sem sessão da equipe. */
function portalClient(t: TestContext) {
  const agent = request.agent(t.app.getHttpServer());
  return {
    agent,
    get: (p: string) => agent.get(`/api/portal${p}`),
    post: (p: string, body: object = {}) => agent.post(`/api/portal${p}`).set(CSRF_HEADER, '1').send(body),
    put: (p: string, body: object = {}) => agent.put(`/api/portal${p}`).set(CSRF_HEADER, '1').send(body),
  };
}

describe('Portal do paciente', () => {
  let t: TestContext;
  let c: Clinic;
  let dentist: Client;
  let patientId: string;
  let otherPatient: string;
  let apptId: string;
  let planId: string;
  let token = '';
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  let portal: ReturnType<typeof portalClient>;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'clinica-portal@exemplo.test');
    const d = await addMember(t.app, c, 'dent-portal@exemplo.test', 'dentist');
    dentist = d.client;
    const prof = await createProfessional(c, 'Dra. Portal', { membershipId: d.membershipId });
    patientId = await createPatient(c.owner, c.orgId, 'Paciente Portal Silva', { email: 'paciente@portal.example' });
    otherPatient = await createPatient(c.owner, c.orgId, 'Outro Paciente Portal');
    apptId = (await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId, professionalId: prof, startsAt: at('2030-03-20', '10:00'), durationMinutes: 30 })).body.id;
    await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId: otherPatient, professionalId: prof, startsAt: at('2030-03-20', '11:00'), durationMinutes: 30 });
    planId = (await dentist.post(url(`/patients/${patientId}/treatment-plans`), { unitId: c.unitId, title: 'Plano compartilhado', objective: 'Recuperar a função.' })).body.id;
    await dentist.post(url(`/treatment-plans/${planId}/items`), { description: 'Restauração', tooth: 26, unitPrice: '300.00' });
    await dentist.post(url(`/treatment-plans/${planId}/present`), { installments: 2, firstDueDate: '2030-03-25', validUntil: '2030-04-30' });
    portal = portalClient(t);
  });
  afterAll(() => t.close());

  it('sem sessão do portal não há acesso; sessão da equipe não serve', async () => {
    expect((await portal.get('/me')).status).toBe(401);
    expect((await c.owner.get('/portal/me')).status).toBe(401);
  });

  it('clínica gera o link; ele é de uso único', async () => {
    const r = await c.owner.post(url(`/patients/${patientId}/portal-link`), { sendEmail: true });
    expect(r.body.emailDelivery).toBe('logged_locally');
    token = new URL(r.body.url).searchParams.get('token')!;
    expect((await portal.post('/access', { token })).status).toBe(200);
    expect((await portal.get('/me')).body.patient.firstName).toBe('Paciente');
    const reuse = portalClient(t);
    expect((await reuse.post('/access', { token })).status).toBe(401);
  });

  it('paciente vê só as próprias consultas e confirma presença', async () => {
    const a = await portal.get('/appointments');
    expect(a.body.upcoming.map((x: { id: string }) => x.id)).toEqual([apptId]);
    expect((await portal.post(`/appointments/${apptId}/confirm`)).status).toBe(200);
    const d = await c.owner.get(url(`/appointments/${apptId}`));
    expect(d.body.history.at(-1)).toMatchObject({ toStatus: 'confirmed', source: 'patient_portal' });
  });

  it('não alcança consulta, plano ou documento de outro paciente', async () => {
    const other = (await c.owner.get(url(`/agenda?unitId=${c.unitId}&date=2030-03-20`))).body.appointments.find((x: { patientId: string }) => x.patientId === otherPatient);
    expect((await portal.post(`/appointments/${other.id}/confirm`)).status).toBe(404);
  });

  it('plano só aparece depois que a clínica compartilha; aprovação aponta a versão', async () => {
    expect((await portal.get('/plans')).body).toEqual([]);
    await dentist.put(url(`/treatment-plans/${planId}`), { sharedWithPatient: true });
    const plans = (await portal.get('/plans')).body;
    expect(plans).toHaveLength(1);
    const q = plans[0].quote;
    expect(q.total).toBe('300.00');
    expect((await portal.post(`/quotes/${q.id}/approve`, { versionId: q.versionId, acknowledgedName: 'Paciente Portal Silva' })).status).toBe(422);
    const ok = await portal.post(`/quotes/${q.id}/approve`, { versionId: q.versionId, acknowledgedName: 'Paciente Portal Silva', accept: true });
    expect(ok.status).toBe(200);
    const detail = await dentist.get(url(`/treatment-plans/${planId}`));
    expect(detail.body.quotes[0].decisions[0]).toMatchObject({ via: 'portal', decision: 'approved', acknowledgedName: 'Paciente Portal Silva' });
  });

  it('pagamentos: parcelas geradas pela aprovação aparecem para o paciente', async () => {
    const r = await portal.get('/payments');
    expect(r.body.receivables.map((x: { amount: string }) => x.amount)).toEqual(['150.00', '150.00']);
    expect(r.body.balance).toBe('300.00');
  });

  it('documentos: só os marcados pela clínica, por link temporário', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await dentist.agent.post(`/api${url(`/patients/${patientId}/documents`)}`).set(CSRF_HEADER, '1').field('category', 'orientation').field('title', 'Orientações pós-operatórias').field('sharedWithPatient', 'true').attach('file', png, { filename: 'o.png', contentType: 'image/png' });
    await dentist.agent.post(`/api${url(`/patients/${patientId}/documents`)}`).set(CSRF_HEADER, '1').field('category', 'exam').field('title', 'Exame interno').attach('file', png, { filename: 'e.png', contentType: 'image/png' });
    const docs = (await portal.get('/documents')).body;
    expect(docs.map((d: { title: string }) => d.title)).toEqual(['Orientações pós-operatórias']);
    const link = await portal.post(`/documents/${up.body.id}/download`);
    expect((await request(t.app.getHttpServer()).get(link.body.url)).status).toBe(200);
  });

  it('anamnese enviada pelo paciente fica pendente de revisão e vira tarefa', async () => {
    const forms = (await portal.get('/forms')).body;
    const r = await portal.post('/forms/anamnesis', { templateId: forms[0].id, answers: { alergia: true, alergia_qual: 'Dipirona' } });
    expect(r.status).toBe(201);
    const appt2 = await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId, professionalId: (await c.owner.get(url('/professionals'))).body[0].id, startsAt: at('2030-03-12', '15:00'), durationMinutes: 30 });
    await c.owner.post(url(`/appointments/${appt2.body.id}/transitions`), { to: 'arrived', version: 1 });
    await dentist.post(url(`/appointments/${appt2.body.id}/transitions`), { to: 'in_progress', version: 2 });
    const w = await dentist.get(url(`/appointments/${appt2.body.id}/workspace`));
    expect(w.body.anamnesis.pendingPatientResponse).toBeTruthy();
    expect(w.body.anamnesis.latest).toBeNull();
    const reqs = (await portal.get('/requests')).body;
    expect(reqs.some((x: { title: string }) => /Anamnese/.test(x.title))).toBe(true);
  });

  it('paciente gerencia consentimento; atualização cadastral passa pela clínica', async () => {
    await portal.put('/communication', { preferences: [{ channel: 'email', category: 'promotional', allowed: true }] });
    const m = (await c.owner.get(url(`/patients/${patientId}/communication`))).body;
    expect(m.find((x: { channel: string; category: string }) => x.channel === 'email' && x.category === 'promotional')).toMatchObject({ allowed: true, source: 'patient_portal' });
    expect((await portal.post('/profile-update', { phone: '(11) 97777-6666' })).status).toBe(200);
    const p = (await c.owner.get(url(`/patients/${patientId}`))).body.patient;
    expect(p.phone).toBeNull(); // nada muda sem validação da clínica
  });

  it('pedido de link pelo e-mail não revela se há cadastro', async () => {
    const a = await portalClient(t).post('/request-link', { email: 'paciente@portal.example' });
    const b = await portalClient(t).post('/request-link', { email: 'ninguem@portal.example' });
    expect(a.body).toEqual(b.body);
    const [m] = await t.db.select().from(emailMessages).where(eq(emailMessages.toAddress, 'paciente@portal.example')).orderBy(desc(emailMessages.createdAt)).limit(1);
    expect(m!.bodyText).toContain('/paciente/acesso?token=');
  });

  it('sair encerra a sessão do portal', async () => {
    await portal.post('/logout');
    expect((await portal.get('/me')).status).toBe(401);
  });
});
