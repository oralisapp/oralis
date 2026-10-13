import { sql } from 'drizzle-orm';
import { documents } from '../src/db/schema';
import { addMember, at, createClinic, createPatient, createProfessional, createTestApp, resetDb, TODAY, type TestContext } from './helpers';

describe('Linha do tempo autorizada do paciente', () => {
  let t: TestContext;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.db); });

  it('pagina datas empatadas sem omitir eventos e audita a leitura', async () => {
    const c = await createClinic(t.app, 'timeline@example.test');
    const patientId = await createPatient(c.owner, c.orgId, 'Paciente Jornada');
    await t.db.insert(documents).values(Array.from({ length: 35 }, (_, i) => ({ organizationId: c.orgId, patientId, category: 'administrative', title: `Documento ${i}`, createdAt: new Date('2030-03-12T13:00:00.123Z') })));
    const first = await c.owner.get(`/orgs/${c.orgId}/patients/${patientId}/timeline`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(30);
    const second = await c.owner.get(`/orgs/${c.orgId}/patients/${patientId}/timeline?${new URLSearchParams(first.body.next)}`);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.next).toBeNull();
    expect(new Set([...first.body.items, ...second.body.items].map((x: { key: string }) => x.key)).size).toBe(35);
    const audit = await t.db.execute(sql`select count(*)::int as n from audit_events where action = 'patient.timeline_viewed' and entity_id = ${patientId}`);
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('omite documentos clínicos e consultas fora das unidades, isolando outras clínicas', async () => {
    const c = await createClinic(t.app, 'timeline-owner@example.test');
    const other = await createClinic(t.app, 'timeline-other@example.test');
    const patientId = await createPatient(c.owner, c.orgId, 'Paciente Jornada');
    const unit = await c.owner.post(`/orgs/${c.orgId}/units`, { unit: { name: 'Outra', timezone: 'America/Sao_Paulo' }, businessHours: [] });
    const reader = await addMember(t.app, c, 'timeline-reader@example.test', 'reception', { allUnits: false, unitIds: [unit.body.id] });
    const professionalId = await createProfessional(c, 'Dentista');
    expect((await c.owner.post(`/orgs/${c.orgId}/appointments`, { unitId: c.unitId, patientId, professionalId, startsAt: at(TODAY, '14:00'), durationMinutes: 30 })).status).toBe(201);
    await t.db.insert(documents).values([{ organizationId: c.orgId, patientId, category: 'exam', title: 'Exame restrito' }, { organizationId: c.orgId, patientId, category: 'administrative', title: 'Cadastro' }]);
    const result = await reader.client.get(`/orgs/${c.orgId}/patients/${patientId}/timeline`);
    expect(result.status).toBe(200);
    expect(result.body.items.map((x: { title: string }) => x.title)).toEqual(['Cadastro']);
    expect((await other.owner.get(`/orgs/${other.orgId}/patients/${patientId}/timeline`)).status).toBe(404);
    expect((await c.owner.get(`/orgs/${c.orgId}/patients/${patientId}/timeline?before=invalid`)).status).toBe(422);
  });
});
