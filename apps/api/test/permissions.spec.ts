import {
  type Clinic,
  type Client,
  type TestContext,
  TODAY,
  TZ,
  addMember,
  at,
  createClinic,
  createPatient,
  createProfessional,
  createTestApp,
  resetDb,
  roleId,
  signup,
} from './helpers';

/**
 * Critério de aceitação: nenhuma ação proibida pode ser executada chamando
 * a API diretamente. Todos os testes aqui ignoram a interface.
 */
describe('Permissões por papel e unidade', () => {
  let t: TestContext;
  let clinic: Clinic;
  let parqueId: string;
  let reception: Client;
  let finance: Client;
  let dentist: { client: Client; membershipId: string };
  let receptionParque: Client;
  let patientId: string;
  let profDentist: string;
  let profOther: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    clinic = await createClinic(t.app, 'dona@exemplo.test');
    const parque = await clinic.owner.post(`/orgs/${clinic.orgId}/units`, {
      unit: { name: 'Parque', timezone: TZ },
      businessHours: [{ weekday: 2, opensAt: '08:00', closesAt: '18:00' }],
    });
    expect(parque.status).toBe(201);
    parqueId = parque.body.id;

    reception = (await addMember(t.app, clinic, 'recepcao@exemplo.test', 'reception')).client;
    finance = (await addMember(t.app, clinic, 'financeiro@exemplo.test', 'finance')).client;
    dentist = await addMember(t.app, clinic, 'dentista@exemplo.test', 'dentist');
    receptionParque = (await addMember(t.app, clinic, 'recepcao-parque@exemplo.test', 'reception', { allUnits: false, unitIds: [parqueId] })).client;

    patientId = await createPatient(clinic.owner, clinic.orgId, 'Carla Mendes');
    profDentist = await createProfessional(clinic, 'Dra. Dentista', { membershipId: dentist.membershipId, unitIds: [clinic.unitId, parqueId] });
    profOther = await createProfessional(clinic, 'Dr. Outro', { unitIds: [clinic.unitId] });
  });
  afterAll(() => t.close());

  const appt = (professionalId: string, hhmm: string, unitId?: string) => ({
    unitId: unitId ?? clinic.unitId,
    patientId,
    professionalId,
    startsAt: at(TODAY, hhmm),
    durationMinutes: 30,
  });

  it('recepção não convida membros, não cria unidades e não lê auditoria', async () => {
    const role = await roleId(clinic.owner, clinic.orgId, 'dentist');
    expect((await reception.post(`/orgs/${clinic.orgId}/invitations`, { email: 'x@exemplo.test', roleId: role, allUnits: true })).status).toBe(403);
    expect((await reception.post(`/orgs/${clinic.orgId}/units`, { unit: { name: 'X', timezone: TZ }, businessHours: [] })).status).toBe(403);
    expect((await reception.get(`/orgs/${clinic.orgId}/audit`)).status).toBe(403);
  });

  it('financeiro não vê agenda nem agenda consultas', async () => {
    expect((await finance.get(`/orgs/${clinic.orgId}/agenda?unitId=${clinic.unitId}&date=${TODAY}`)).status).toBe(403);
    expect((await finance.post(`/orgs/${clinic.orgId}/appointments`, appt(profOther, '09:00'))).status).toBe(403);
  });

  it('recepção agenda, confirma e faz check-in, mas não inicia atendimento', async () => {
    const r = await reception.post(`/orgs/${clinic.orgId}/appointments`, appt(profDentist, '11:00'));
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await reception.post(`/orgs/${clinic.orgId}/appointments/${id}/transitions`, { to: 'confirmed', version: 1 })).status).toBe(201);
    expect((await reception.post(`/orgs/${clinic.orgId}/appointments/${id}/transitions`, { to: 'arrived', version: 2 })).status).toBe(201);
    const start = await reception.post(`/orgs/${clinic.orgId}/appointments/${id}/transitions`, { to: 'in_progress', version: 3 });
    expect(start.status).toBe(403);
  });

  it('dentista inicia apenas as próprias consultas', async () => {
    const own = (await clinic.owner.post(`/orgs/${clinic.orgId}/appointments`, appt(profDentist, '13:00'))).body.id;
    const other = (await clinic.owner.post(`/orgs/${clinic.orgId}/appointments`, { ...appt(profOther, '13:00'), patientId: await createPatient(clinic.owner, clinic.orgId, 'Outro Paciente') })).body.id;
    for (const id of [own, other]) {
      await clinic.owner.post(`/orgs/${clinic.orgId}/appointments/${id}/transitions`, { to: 'arrived', version: 1 });
    }
    expect((await dentist.client.post(`/orgs/${clinic.orgId}/appointments/${own}/transitions`, { to: 'in_progress', version: 2 })).status).toBe(201);
    const denied = await dentist.client.post(`/orgs/${clinic.orgId}/appointments/${other}/transitions`, { to: 'in_progress', version: 2 });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/profissional responsável/);
  });

  it('membro restrito à unidade Parque não acessa a agenda do Centro', async () => {
    expect((await receptionParque.get(`/orgs/${clinic.orgId}/agenda?unitId=${clinic.unitId}&date=${TODAY}`)).status).toBe(404);
    expect((await receptionParque.post(`/orgs/${clinic.orgId}/appointments`, appt(profDentist, '15:00'))).status).toBe(404);
    expect((await receptionParque.get(`/orgs/${clinic.orgId}/agenda?unitId=${parqueId}&date=${TODAY}`)).status).toBe(200);
    const me = await receptionParque.get('/auth/me');
    expect(me.body.memberships[0].units.map((u: { id: string }) => u.id)).toEqual([parqueId]);
  });

  it('gestor não concede o papel de proprietário', async () => {
    const manager = (await addMember(t.app, clinic, 'gestor@exemplo.test', 'manager')).client;
    const ownerRole = await roleId(clinic.owner, clinic.orgId, 'owner');
    const r = await manager.post(`/orgs/${clinic.orgId}/invitations`, { email: 'novo-dono@exemplo.test', roleId: ownerRole, allUnits: true });
    expect(r.status).toBe(403);
  });

  it('mudança de papel vale na requisição seguinte, sem novo login', async () => {
    const tmp = await addMember(t.app, clinic, 'temporario@exemplo.test', 'reception');
    expect((await tmp.client.get(`/orgs/${clinic.orgId}/agenda?unitId=${clinic.unitId}&date=${TODAY}`)).status).toBe(200);
    const financeRole = await roleId(clinic.owner, clinic.orgId, 'finance');
    const upd = await clinic.owner.put(`/orgs/${clinic.orgId}/members/${tmp.membershipId}`, { roleId: financeRole, allUnits: true, unitIds: [] });
    expect(upd.status).toBe(200);
    expect((await tmp.client.get(`/orgs/${clinic.orgId}/agenda?unitId=${clinic.unitId}&date=${TODAY}`)).status).toBe(403);

    expect((await clinic.owner.delete(`/orgs/${clinic.orgId}/members/${tmp.membershipId}`)).status).toBe(200);
    expect((await tmp.client.get(`/orgs/${clinic.orgId}/patients`)).status).toBe(404);
  });

  it('a organização mantém ao menos um proprietário', async () => {
    const me = await clinic.owner.get('/auth/me');
    const ownMembership = me.body.memberships[0].membershipId;
    const r = await clinic.owner.delete(`/orgs/${clinic.orgId}/members/${ownMembership}`);
    expect(r.status).toBe(409);
  });

  it('convite só pode ser aceito pela conta do e-mail convidado e uma única vez', async () => {
    const role = await roleId(clinic.owner, clinic.orgId, 'assistant');
    const inv = await clinic.owner.post(`/orgs/${clinic.orgId}/invitations`, { email: 'auxiliar@exemplo.test', roleId: role, allUnits: true });
    expect(inv.body.emailDelivery).toBe('logged_locally');
    expect((await reception.post('/invitations/accept', { token: inv.body.token })).status).toBe(403);
    const aux = await signup(t.app, 'auxiliar@exemplo.test');
    expect((await aux.post('/invitations/accept', { token: inv.body.token })).status).toBe(201);
    expect((await aux.post('/invitations/accept', { token: inv.body.token })).status).toBe(404);
  });
});
