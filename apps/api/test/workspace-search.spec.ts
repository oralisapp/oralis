import { emailMessages, jobs } from '../src/db/schema';
import { addMember, at, createChair, createClinic, createPatient, createProfessional, createTestApp, resetDb, TODAY, type TestContext } from './helpers';

describe('Busca global e operação HTTP', () => {
  let t: TestContext;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.db); });

  it('isola organizações e respeita permissão de agenda na busca', async () => {
    const c = await createClinic(t.app, 'search-owner@example.test');
    const other = await createClinic(t.app, 'search-other@example.test');
    const patientId = await createPatient(c.owner, c.orgId, 'João Busca');
    await createPatient(other.owner, other.orgId, 'João Sigiloso');
    const professionalId = await createProfessional(c, 'Dra. Busca');
    const chairId = await createChair(c, 'Sala busca');
    const a = await c.owner.post(`/orgs/${c.orgId}/appointments`, { unitId: c.unitId, patientId, professionalId, chairId, startsAt: at(TODAY, '14:00'), durationMinutes: 30 });
    expect(a.status).toBe(201);
    const found = await c.owner.get(`/orgs/${c.orgId}/search?q=joao`);
    expect(found.status).toBe(200);
    expect(found.body.patients.map((p: { id: string }) => p.id)).toEqual([patientId]);
    expect(found.body.appointments.map((p: { id: string }) => p.id)).toEqual([a.body.id]);
    expect(JSON.stringify(found.body)).not.toContain('Sigiloso');
    const finance = await addMember(t.app, c, 'search-finance@example.test', 'finance');
    const limited = await finance.client.get(`/orgs/${c.orgId}/search?q=joao`);
    expect(limited.status).toBe(200);
    expect(limited.body.appointments).toEqual([]);
    expect((await other.owner.get(`/orgs/${c.orgId}/search?q=joao`)).status).toBe(404);
  });

  it('não revela consultas de unidade fora do vínculo e trata caracteres de LIKE literalmente', async () => {
    const c = await createClinic(t.app, 'search-units@example.test');
    const r = await c.owner.post(`/orgs/${c.orgId}/units`, { unit: { name: 'Restrita', timezone: 'America/Sao_Paulo' }, businessHours: [] });
    expect(r.status).toBe(201);
    const reader = await addMember(t.app, c, 'search-reception@example.test', 'reception', { allUnits: false, unitIds: [r.body.id] });
    const patientId = await createPatient(c.owner, c.orgId, 'Paciente Busca');
    const professionalId = await createProfessional(c, 'Dentista');
    await c.owner.post(`/orgs/${c.orgId}/appointments`, { unitId: c.unitId, patientId, professionalId, startsAt: at(TODAY, '14:00'), durationMinutes: 30 });
    const found = await reader.client.get(`/orgs/${c.orgId}/search?q=Busca`);
    expect(found.status).toBe(200);
    expect(found.body.appointments).toEqual([]);
    expect((await c.owner.get(`/orgs/${c.orgId}/search?q=%25%25`)).body.patients).toEqual([]);
    expect((await c.owner.get(`/orgs/${c.orgId}/search?q=a`)).status).toBe(422);
  });

  it('expõe liveness/readiness sem dados e correlaciona erros por identificador', async () => {
    const c = await createClinic(t.app, 'health-owner@example.test');
    const live = await c.owner.get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await c.owner.get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const error = await c.owner.get(`/orgs/${c.orgId}/search?q=x`);
    expect(error.body.error.requestId).toBe(error.headers['x-request-id']);
  });
  it('restringe indicadores operacionais por organização e permissão', async () => {
    const c = await createClinic(t.app, 'ops-owner@example.test');
    const other = await createClinic(t.app, 'ops-other@example.test');
    await t.db.insert(jobs).values([
      { organizationId: c.orgId, kind: 'test', status: 'dead' },
      { organizationId: other.orgId, kind: 'test', status: 'dead' },
      { organizationId: c.orgId, kind: 'test', status: 'running', lockedAt: new Date('2000-01-01T00:00:00Z') },
    ]);
    await t.db.insert(emailMessages).values({ organizationId: other.orgId, toAddress: 'test@example.test', subject: 'private', status: 'failed' });
    const result = await c.owner.get('/orgs/' + c.orgId + '/workspace/operations');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ failedJobs: 1, staleJobs: 1, failedEmails: 0 });
    const reception = await addMember(t.app, c, 'ops-reception@example.test', 'reception');
    expect((await reception.client.get('/orgs/' + c.orgId + '/workspace/operations')).status).toBe(403);
  });

});
