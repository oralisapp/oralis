import { eq } from 'drizzle-orm';
import { createTransport } from 'nodemailer';
import { emailMessages, tasks } from '../src/db/schema';
import { overrideEnvForTests } from '../src/config/env';
import { JobsService } from '../src/modules/platform/jobs.service';
import { MailService } from '../src/modules/platform/mail.service';
import { addMember, createClinic, createPatient, createTestApp, resetDb, type TestContext, type Clinic, type Client, TZ } from './helpers';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('Confiabilidade: unidades, CSV e concorrência de e-mail', () => {
  let t: TestContext;
  let c: Clinic;
  let other: Clinic;
  let member: Client;
  let membershipId: string;
  let unit: string;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'reliable@exemplo.test');
    other = await createClinic(t.app, 'other-reliable@exemplo.test');
    unit = (await c.owner.post(url('/units'), { unit: { name: 'Norte', timezone: TZ }, businessHours: [] })).body.id;
    const m = await addMember(t.app, c, 'restricted@exemplo.test', 'reception', { allUnits: false, unitIds: [unit] });
    member = m.client;
    membershipId = m.membershipId;
  });
  afterAll(async () => { overrideEnvForTests({ SMTP_URL: undefined }); await t.close(); });

  it('nega criação e alteração de tarefa de unidade não autorizada', async () => {
    expect((await member.post(url('/tasks'), { title: 'Restrita', unitId: c.unitId })).status).toBe(404);
    const task = await c.owner.post(url('/tasks'), { title: 'Restrita', unitId: c.unitId });
    expect(task.status).toBe(201);
    expect((await member.put(url(`/tasks/${task.body.id}/status`), { status: 'done' })).status).toBe(404);
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.body.id)))[0]!.status).toBe('open');
  });
  it('valida unidade da organização e responsável com acesso à unidade', async () => {
    expect((await c.owner.post(url('/tasks'), { title: 'Outra clínica', unitId: other.unitId })).status).toBe(404);
    expect((await c.owner.post(url('/tasks'), { title: 'Responsável incorreto', unitId: c.unitId, assigneeMembershipId: membershipId })).status).toBe(404);
    const otherMembership = (await other.owner.get('/auth/me')).body.memberships[0].membershipId;
    expect((await c.owner.post(url('/tasks'), { title: 'Outra clínica', assigneeMembershipId: otherMembership })).status).toBe(404);
    expect((await member.post(url('/tasks'), { title: 'Permitida', unitId: unit, assigneeMembershipId: membershipId })).status).toBe(201);
  });
  it('aplica escopo de unidade antes de limitar a lista', async () => {
    await t.db.insert(tasks).values(Array.from({ length: 205 }, (_, i) => ({ organizationId: c.orgId, unitId: c.unitId, title: `Oculta ${i}`, dueAt: new Date('2030-01-01') })));
    const visible = await member.post(url('/tasks'), { title: 'Visível depois das ocultas', unitId: unit });
    const list = await member.get(url('/tasks?scope=all'));
    expect(list.body.some((x: { id: string }) => x.id === visible.body.id)).toBe(true);
    expect(list.body.every((x: { unitId: string }) => x.unitId === unit || x.unitId === null)).toBe(true);
    expect((await member.put(url(`/tasks/${visible.body.id}/status`), { status: 'done' })).status).toBe(200);
  });
  it('neutraliza fórmulas e mantém aspas e separadores no CSV', async () => {
    await createPatient(c.owner, c.orgId, '=1+1', { socialName: '@SUM(1;2)' });
    const e = await c.owner.post(url('/exports'), { scope: 'patients' });
    await t.app.get(JobsService).drain();
    const file = await c.owner.agent.get(`/api${url(`/exports/${e.body.id}/download`)}`).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (x: Buffer) => (d += x.toString())); res.on('end', () => cb(null, d)); });
    expect(file.status).toBe(200);
    expect(file.body).toContain("'=1+1");
    expect(file.body).toContain('"\'@SUM(1;2)"');
  });
  it('duas instâncias não enviam simultaneamente a mesma mensagem; recupera primeira tentativa sem data', async () => {
    overrideEnvForTests({ SMTP_URL: 'smtp://localhost:1025' });
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'simulado' });
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
    const [m] = await t.db.insert(emailMessages).values({ toAddress: 'fake@example.test', subject: 'Sem envio real', bodyText: 'teste', status: 'pending', nextAttemptAt: null }).returning();
    const a = new MailService(t.db, t.clock);
    const b = new MailService(t.db, t.clock);
    await Promise.all([a.retryDue(), b.retryDue()]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((await t.db.select().from(emailMessages).where(eq(emailMessages.id, m!.id)))[0]).toMatchObject({ status: 'sent', attempts: 1, bodyText: null });
  });
  it('falha SMTP respeita backoff mesmo com workers concorrentes e não reenvia esgotadas', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('SMTP simulado indisponível'));
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
    const [m] = await t.db.insert(emailMessages).values({ toAddress: 'fake@example.test', subject: 'Falha simulada', status: 'pending', bodyText: 'teste', nextAttemptAt: t.clock.now() }).returning();
    const a = new MailService(t.db, t.clock);
    const b = new MailService(t.db, t.clock);
    await Promise.all([a.retryDue(), b.retryDue()]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    await a.retryDue();
    expect(sendMail).toHaveBeenCalledTimes(1);
    await t.db.update(emailMessages).set({ attempts: 4, nextAttemptAt: t.clock.now() }).where(eq(emailMessages.id, m!.id));
    await a.retryDue();
    await a.retryDue();
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect((await t.db.select().from(emailMessages).where(eq(emailMessages.id, m!.id)))[0]!.status).toBe('failed');
  });
});
