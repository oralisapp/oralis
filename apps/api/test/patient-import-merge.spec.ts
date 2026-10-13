import { and, eq, sql } from 'drizzle-orm';
import { auditEvents, patients, clinicalRecords } from '../src/db/schema';
import { parsePatientCsv } from '../src/modules/patients/patient-import.service';
import { addMember, createClinic, createPatient, createProfessional, createTestApp, resetDb, type Clinic, type TestContext } from './helpers';

describe('Importação e consolidação de pacientes', () => {
  let t: TestContext; let c: Clinic;
  const base = () => `/orgs/${c.orgId}/patients`;
  beforeAll(async () => { t = await createTestApp(); await resetDb(t.db); c = await createClinic(t.app, 'import-merge@example.test'); });
  afterAll(() => t.close());

  it('lê campos entre aspas, delimitadores e quebras de linha, rejeita CSV truncado', () => {
    expect(parsePatientCsv('nome;nota\r\n"Maria; Silva";"linha 1\nlinha ""2"""', ';')[1]).toEqual(['Maria; Silva', 'linha 1\nlinha "2"']);
    expect(() => parsePatientCsv('nome\n"aberto', ';')).toThrow();
    expect(parsePatientCsv('\uFEFF"Nome";"CPF"\nMaria;', ';')[0]).toEqual(['Nome', 'CPF']);
  });

  it('prévia não grava; confirma lote e ignora duplicados inclusive repetição da requisição', async () => {
    const body = { csv: 'Nome;CPF;Nascimento\nPaciente Importado;52998224725;1990-01-01\nPaciente Importado;52998224725;1990-01-01', delimiter: ';', mapping: { fullName: 0, cpf: 1, birthDate: 2 } };
    const preview = await c.owner.post(`${base()}/import/preview`, body);
    expect(preview.status).toBe(201); expect(preview.body.rows.map((r: { status: string }) => r.status)).toEqual(['ready', 'duplicate']);
    expect((await c.owner.get(`${base()}?q=Paciente%20Importado`)).body.total).toBe(0);
    const results = await Promise.all([c.owner.post(`${base()}/import/commit`, body), c.owner.post(`${base()}/import/commit`, body)]);
    expect(results.map(r => r.status)).toEqual([201, 201]);
    expect(results.reduce((n, r) => n + r.body.imported, 0)).toBe(1);
  });

  it('não grava nenhuma linha quando há erro e recusa mapeamento repetido', async () => {
    const body = { csv: 'Nome;CPF\nPessoa Válida;\nPessoa Inválida;123', mapping: { fullName: 0, cpf: 1 } };
    expect((await c.owner.post(`${base()}/import/commit`, body)).status).toBe(422);
    expect((await c.owner.get(`${base()}?q=Pessoa%20Válida`)).body.total).toBe(0);
    expect((await c.owner.post(`${base()}/import/preview`, { ...body, mapping: { fullName: 0, cpf: 0 } })).status).toBe(422);
  });

  it('torna repetição sem CPF ou nascimento idempotente e limita arquivo em bytes', async () => {
    const body = { csv: 'Nome\nPaciente Sem Identificadores', mapping: { fullName: 0 } };
    expect((await c.owner.post(`${base()}/import/commit`, body)).body.imported).toBe(1);
    expect((await c.owner.post(`${base()}/import/commit`, body)).body.imported).toBe(0);
    expect((await c.owner.post(`${base()}/import/columns`, { csv: 'Nome\n' + 'é'.repeat(50_001) })).status).toBe(422);
  });

  it('consolida atomicamente preservando registro finalizado e relações, com auditoria e histórico vinculado', async () => {
    const sourceId = await createPatient(c.owner, c.orgId, 'Origem Histórica');
    const targetId = await createPatient(c.owner, c.orgId, 'Principal Histórico');
    const [source] = await t.db.select().from(patients).where(eq(patients.id, sourceId));
    const professionalId = await createProfessional(c, 'Dra. Consolidação');
    // Insert valid standalone finalized record to prove byte-for-byte preservation.
    const record = await t.db.execute<{ id: string }>(sql`INSERT INTO clinical_records (organization_id, patient_id, professional_id, unit_id, author_user_id, status, content, content_hash, finalized_at) VALUES (${c.orgId}::uuid, ${sourceId}::uuid, ${professionalId}::uuid, ${c.unitId}::uuid, ${source!.createdBy}::uuid, 'finalized', 'Histórico imutável', 'hash-original', now()) RETURNING id`);
    const before = await t.db.select().from(clinicalRecords).where(eq(clinicalRecords.id, record.rows[0]!.id));
    const body = { sourceId, targetId, sourceVersion: 1, targetVersion: 1, reason: 'Cadastro repetido confirmado pela equipe' };
    const both = await Promise.all([c.owner.post(`${base()}/consolidate`, body), c.owner.post(`${base()}/consolidate`, body)]);
    expect(both.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await t.db.select().from(clinicalRecords).where(eq(clinicalRecords.id, record.rows[0]!.id))).toEqual(before);
    expect((await c.owner.get(`${base()}/${targetId}/registrations`)).body.items).toEqual([expect.objectContaining({ id: sourceId, direction: 'history' })]);
    expect((await c.owner.get(`${base()}/${sourceId}/registrations`)).body.items[0]).toMatchObject({ id: targetId, direction: 'canonical' });
    expect((await c.owner.get(`${base()}/${sourceId}`)).body.patient.status).toBe('archived');
    expect((await c.owner.put(`${base()}/${sourceId}`, { fullName: 'Alterado', version: 2 })).status).toBe(409);
    await expect(t.db.execute(sql`INSERT INTO clinical_records (organization_id, patient_id, professional_id, unit_id, author_user_id) VALUES (${c.orgId}::uuid, ${sourceId}::uuid, ${professionalId}::uuid, ${c.unitId}::uuid, ${source!.createdBy}::uuid)`)).rejects.toThrow();
    await expect(t.db.update(clinicalRecords).set({ content: 'Alteração proibida' }).where(eq(clinicalRecords.id, record.rows[0]!.id))).rejects.toThrow();
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'patient.consolidated'), eq(auditEvents.entityId, targetId)));
    expect(events).toHaveLength(1); expect(JSON.stringify(events[0]!.metadata)).not.toContain('Histórico');
    const thirdId = await createPatient(c.owner, c.orgId, 'Terceiro Cadastro');
    expect((await c.owner.post(`${base()}/consolidate`, { ...body, sourceId: targetId, targetId: thirdId, sourceVersion: 2 })).status).toBe(409);
  });

  it('isola clínicas e restringe consolidação à gestão com acesso completo', async () => {
    const sourceId = await createPatient(c.owner, c.orgId, 'Origem Permissões');
    const targetId = await createPatient(c.owner, c.orgId, 'Destino Permissões');
    const body = { sourceId, targetId, sourceVersion: 1, targetVersion: 1, reason: 'Teste de isolamento de organizações' };
    const reception = await addMember(t.app, c, 'merge-reception@example.test', 'reception');
    expect((await reception.client.post(`${base()}/consolidate`, body)).status).toBe(403);
    const other = await createClinic(t.app, 'merge-other@example.test');
    const otherPatient = await createPatient(other.owner, other.orgId, 'Outra Organização');
    expect((await c.owner.post(`${base()}/consolidate`, { ...body, targetId: otherPatient })).status).toBe(404);
    expect((await other.owner.get(`${base()}/${sourceId}/registrations`)).status).toBe(404);
    const finance = await addMember(t.app, c, 'import-finance@example.test', 'finance');
    expect((await finance.client.post(`${base()}/import/commit`, { csv: 'Nome\nSem Permissão', mapping: { fullName: 0 } })).status).toBe(403);
  });
});
