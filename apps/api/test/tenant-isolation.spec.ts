import { eq } from 'drizzle-orm';
import { appointments } from '../src/db/schema';
import {
  type Clinic,
  type TestContext,
  TODAY,
  at,
  createChair,
  createClinic,
  createPatient,
  createProfessional,
  createTestApp,
  resetDb,
  signup,
} from './helpers';

/**
 * Critério de aceitação: nenhum usuário acessa dados de outra organização,
 * nem chamando a API diretamente com identificadores conhecidos.
 */
describe('Isolamento entre organizações', () => {
  let t: TestContext;
  let a: Clinic;
  let b: Clinic;
  let patientB: string;
  let professionalB: string;
  let chairB: string;
  let appointmentB: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    a = await createClinic(t.app, 'dona-a@exemplo.test', 'Clínica A');
    b = await createClinic(t.app, 'dona-b@exemplo.test', 'Clínica B');
    patientB = await createPatient(b.owner, b.orgId, 'Paciente da Clínica B');
    professionalB = await createProfessional(b, 'Dra. B');
    chairB = await createChair(b, 'Cadeira B1');
    const appt = await b.owner.post(`/orgs/${b.orgId}/appointments`, {
      unitId: b.unitId,
      patientId: patientB,
      professionalId: professionalB,
      chairId: chairB,
      startsAt: at(TODAY, '14:00'),
      durationMinutes: 30,
    });
    expect(appt.status).toBe(201);
    appointmentB = appt.body.id;
  });
  afterAll(() => t.close());

  it('membro de A recebe 404 em qualquer rota da organização B', async () => {
    const routes = [
      `/orgs/${b.orgId}`,
      `/orgs/${b.orgId}/patients`,
      `/orgs/${b.orgId}/patients/${patientB}`,
      `/orgs/${b.orgId}/units`,
      `/orgs/${b.orgId}/members`,
      `/orgs/${b.orgId}/audit`,
      `/orgs/${b.orgId}/agenda?unitId=${b.unitId}&date=${TODAY}`,
      `/orgs/${b.orgId}/appointments/${appointmentB}`,
    ];
    for (const r of routes) {
      const res = await a.owner.get(r);
      expect({ r, status: res.status }).toEqual({ r, status: 404 });
    }
  });

  it('membro de A não lê recurso de B usando a própria organização na URL', async () => {
    expect((await a.owner.get(`/orgs/${a.orgId}/patients/${patientB}`)).status).toBe(404);
    expect((await a.owner.get(`/orgs/${a.orgId}/appointments/${appointmentB}`)).status).toBe(404);
    expect((await a.owner.get(`/orgs/${a.orgId}/agenda?unitId=${b.unitId}&date=${TODAY}`)).status).toBe(404);
    const search = await a.owner.get(`/orgs/${a.orgId}/patients?q=Clínica B`);
    expect(search.body.items).toEqual([]);
  });

  it('membro de A não altera nem movimenta registros de B', async () => {
    const upd = await a.owner.put(`/orgs/${a.orgId}/patients/${patientB}`, { fullName: 'Invasão', version: 1 });
    expect(upd.status).toBe(404);
    const tr = await a.owner.post(`/orgs/${a.orgId}/appointments/${appointmentB}/transitions`, { to: 'cancelled', reason: 'other', version: 1 });
    expect(tr.status).toBe(404);
    const [row] = await t.db.select().from(appointments).where(eq(appointments.id, appointmentB));
    expect(row!.status).toBe('scheduled');
  });

  it('membro de A não agenda em A usando paciente, profissional ou cadeira de B', async () => {
    const patientA = await createPatient(a.owner, a.orgId, 'Paciente A');
    const profA = await createProfessional(a, 'Dr. A');
    const base = { unitId: a.unitId, patientId: patientA, professionalId: profA, startsAt: at(TODAY, '15:00'), durationMinutes: 30 };
    expect((await a.owner.post(`/orgs/${a.orgId}/appointments`, { ...base, patientId: patientB })).status).toBe(404);
    expect((await a.owner.post(`/orgs/${a.orgId}/appointments`, { ...base, professionalId: professionalB })).status).toBe(404);
    expect((await a.owner.post(`/orgs/${a.orgId}/appointments`, { ...base, chairId: chairB })).status).toBe(404);
    expect((await a.owner.post(`/orgs/${a.orgId}/appointments`, { ...base, unitId: b.unitId })).status).toBe(404);
  });

  it('o banco recusa referência cruzada mesmo se a aplicação falhar (FK composta)', async () => {
    const patientA = await createPatient(a.owner, a.orgId, 'Paciente A2');
    await expect(
      t.db.insert(appointments).values({
        organizationId: a.orgId,
        unitId: a.unitId,
        patientId: patientA,
        professionalId: professionalB,
        startsAt: new Date('2030-03-20T12:00:00Z'),
        endsAt: new Date('2030-03-20T12:30:00Z'),
        createdBy: (await a.owner.get('/auth/me')).body.user.id,
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('usuário sem vínculo não vê a organização nem por /auth/me', async () => {
    const outsider = await signup(t.app, 'curioso@exemplo.test');
    const me = await outsider.get('/auth/me');
    expect(me.body.memberships).toEqual([]);
    expect((await outsider.get(`/orgs/${a.orgId}/patients`)).status).toBe(404);
  });

  it('identificador malformado não vaza erro interno', async () => {
    const r = await a.owner.get('/orgs/nao-e-uuid/patients');
    expect(r.status).toBe(404);
  });
});
