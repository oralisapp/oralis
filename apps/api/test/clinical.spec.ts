import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { CSRF_HEADER } from '@oralis/shared';
import { auditEvents, clinicalRecords } from '../src/db/schema';
import { type Client, type Clinic, type TestContext, TODAY, addMember, at, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Prontuário e workspace de atendimento', () => {
  let t: TestContext;
  let c: Clinic;
  let dentist: Client;
  let reception: Client;
  let finance: Client;
  let patientId: string;
  let apptId: string;
  let recordId: string;
  let version = 1;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'clinica-prontuario@exemplo.test');
    const d = await addMember(t.app, c, 'dentista-pront@exemplo.test', 'dentist');
    dentist = d.client;
    reception = (await addMember(t.app, c, 'recep-pront@exemplo.test', 'reception')).client;
    finance = (await addMember(t.app, c, 'fin-pront@exemplo.test', 'finance')).client;
    const prof = await createProfessional(c, 'Dra. Prontuário', { membershipId: d.membershipId });
    patientId = await createPatient(reception, c.orgId, 'Paciente Clínico');
    const a = await reception.post(url('/appointments'), { unitId: c.unitId, patientId, professionalId: prof, startsAt: at(TODAY, '14:00'), durationMinutes: 60 });
    apptId = a.body.id;
    await reception.post(url(`/appointments/${apptId}/transitions`), { to: 'arrived', version: 1 });
    const start = await dentist.post(url(`/appointments/${apptId}/transitions`), { to: 'in_progress', version: 2 });
    expect(start.status).toBe(201);
  });
  afterAll(() => t.close());

  it('iniciar o atendimento cria o encontro e um rascunho do dentista', async () => {
    const w = await dentist.get(url(`/appointments/${apptId}/workspace`));
    expect(w.status).toBe(200);
    expect(w.body.encounter).toBeTruthy();
    expect(w.body.records).toHaveLength(1);
    expect(w.body.records[0]).toMatchObject({ status: 'draft', content: '' });
    recordId = w.body.records[0].id;
    version = w.body.records[0].version;
  });

  it('recepção e financeiro não acessam o prontuário, nem pela API', async () => {
    for (const cl of [reception, finance]) {
      expect((await cl.get(url(`/appointments/${apptId}/workspace`))).status).toBe(403);
      expect((await cl.get(url(`/patients/${patientId}/clinical`))).status).toBe(403);
      expect((await cl.put(url(`/clinical-records/${recordId}`), { content: 'x', version })).status).toBe(403);
    }
  });

  it('salva rascunho e detecta edição concorrente devolvendo a versão do servidor', async () => {
    const r1 = await dentist.put(url(`/clinical-records/${recordId}`), { content: 'Paciente relata sensibilidade no 36.', procedures: [], version });
    expect(r1.status).toBe(200);
    const stale = await dentist.put(url(`/clinical-records/${recordId}`), { content: 'Outra janela', version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.serverContent).toBe('Paciente relata sensibilidade no 36.');
    version = r1.body.version;
  });

  it('outra pessoa não vê nem edita o rascunho alheio', async () => {
    const w = await c.owner.get(url(`/appointments/${apptId}/workspace`));
    expect(w.body.records).toHaveLength(0);
    expect(w.body.othersDrafting).toBe(true);
    expect((await c.owner.put(url(`/clinical-records/${recordId}`), { content: 'invasão', version })).status).toBe(403);
  });

  it('finaliza com hash e autoria; depois disso não há edição, nem direto no banco', async () => {
    await dentist.put(url(`/clinical-records/${recordId}`), { content: 'Restauração classe I no 36 (O). Orientado sobre higiene.', procedures: [{ description: 'Restauração em resina', tooth: 36, surfaces: ['O'] }], version });
    version += 1;
    const f = await dentist.post(url(`/clinical-records/${recordId}/finalize`), { version });
    expect(f.status).toBe(201);
    expect(f.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await dentist.put(url(`/clinical-records/${recordId}`), { content: 'mudança', version: version })).status).toBe(409);
    await expect(t.db.execute(sql`update clinical_records set content = 'adulterado' where id = ${recordId}`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(t.db.execute(sql`delete from clinical_records where id = ${recordId}`)).rejects.toMatchObject({ cause: { code: '42501' } });
    const [row] = await t.db.select().from(clinicalRecords).where(eq(clinicalRecords.id, recordId));
    expect(row!.content).toContain('Restauração classe I');
  });

  it('adendo complementa sem sobrescrever e também é imutável', async () => {
    const a = await dentist.post(url(`/clinical-records/${recordId}/amendments`), { content: 'Correção: superfície oclusal e vestibular.' });
    expect(a.status).toBe(201);
    const h = await dentist.get(url(`/patients/${patientId}/clinical`));
    const rec = h.body.records.find((r: { id: string }) => r.id === recordId);
    expect(rec.content).toContain('Restauração classe I');
    expect(rec.amendments).toHaveLength(1);
    await expect(t.db.execute(sql`update clinical_record_amendments set content = 'x'`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('acesso ao prontuário é auditado sem conteúdo clínico', async () => {
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'clinical.viewed'), eq(auditEvents.entityId, patientId)));
    expect(events.length).toBeGreaterThan(0);
    const fin = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'clinical.record_finalized'));
    expect(JSON.stringify(fin[0]!.metadata)).not.toContain('Restauração');
  });

  it('anamnese versionada: respostas antigas continuam ligadas à versão usada', async () => {
    const tpl = await dentist.get(url('/anamnesis-templates'));
    const t1 = tpl.body[0];
    const r = await dentist.post(url(`/patients/${patientId}/anamnesis`), { templateId: t1.id, answers: { alergia: true, alergia_qual: 'Penicilina' } });
    expect(r.status).toBe(201);
    expect((await dentist.post(url(`/patients/${patientId}/anamnesis`), { templateId: t1.id, answers: { inexistente: 'x' } })).status).toBe(422);
    const v2 = await dentist.put(url(`/anamnesis-templates/${t1.id}`), { name: t1.name, questions: [...t1.questions, { id: 'bruxismo', label: 'Range os dentes?', type: 'yesno' }] });
    expect(v2.body.version).toBe(2);
    const w = await dentist.get(url(`/appointments/${apptId}/workspace`));
    expect(w.body.anamnesis.latest.template.version).toBe(1);
  });

  it('alertas clínicos aparecem no atendimento até serem resolvidos', async () => {
    const a = await dentist.post(url(`/patients/${patientId}/clinical-alerts`), { kind: 'allergy', description: 'Alergia a penicilina', severity: 'critical' });
    let w = await dentist.get(url(`/appointments/${apptId}/workspace`));
    expect(w.body.alerts.map((x: { description: string }) => x.description)).toContain('Alergia a penicilina');
    await dentist.post(url(`/clinical-alerts/${a.body.id}/resolve`));
    w = await dentist.get(url(`/appointments/${apptId}/workspace`));
    expect(w.body.alerts).toHaveLength(0);
  });

  describe('documentos', () => {
    const uploadAs = (cl: Client, fields: Record<string, string>, buffer: Buffer, filename: string, contentType: string) => {
      let r = cl.agent.post(`/api${url(`/patients/${patientId}/documents`)}`).set(CSRF_HEADER, '1');
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r.attach('file', buffer, { filename, contentType });
    };

    it('aceita imagem válida e recusa arquivo cujo conteúdo não bate com o tipo', async () => {
      const ok = await uploadAs(dentist, { category: 'exam', title: 'Radiografia periapical' }, PNG, 'rx.png', 'image/png');
      expect(ok.status).toBe(201);
      const fake = await uploadAs(dentist, { category: 'exam', title: 'Falso PDF' }, Buffer.from('não sou pdf'), 'x.pdf', 'application/pdf');
      expect(fake.status).toBe(422);
    });

    it('recepção envia documento administrativo, mas não exame', async () => {
      expect((await uploadAs(reception, { category: 'administrative', title: 'Documento de identidade' }, PNG, 'rg.png', 'image/png')).status).toBe(201);
      expect((await uploadAs(reception, { category: 'exam', title: 'Exame' }, PNG, 'e.png', 'image/png')).status).toBe(403);
      const list = await reception.get(url(`/patients/${patientId}/documents`));
      expect(list.body.map((d: { category: string }) => d.category)).toEqual(['administrative']);
    });

    it('download só por link assinado e temporário', async () => {
      const list = await dentist.get(url(`/patients/${patientId}/documents`));
      const exam = list.body.find((d: { category: string }) => d.category === 'exam');
      const link = await dentist.post(url(`/documents/${exam.id}/download`), {});
      const server = t.app.getHttpServer();
      const ok = await request(server).get(link.body.url);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('image/png');
      expect((await request(server).get(link.body.url.replace(/sig=[^&]+/, 'sig=adulterada'))).status).toBe(404);
      const versionId = link.body.url.split('/api/files/')[1].split('?')[0];
      expect((await request(server).get(`/api/files/${versionId}`)).status).toBe(404);
      t.clock.set(new Date(t.clock.now().getTime() + 6 * 60_000).toISOString());
      expect((await request(server).get(link.body.url)).status).toBe(404);
      t.clock.set('2030-03-12T13:00:00.000Z');
    });
  });

  it('outra organização não alcança o registro clínico', async () => {
    const other = await createClinic(t.app, 'outra-clinica-pront@exemplo.test');
    expect((await other.owner.put(`/orgs/${other.orgId}/clinical-records/${recordId}`, { content: 'x', version: 1 })).status).toBe(404);
    expect((await other.owner.post(`/orgs/${other.orgId}/clinical-records/${recordId}/amendments`, { content: 'invasão' })).status).toBe(404);
  });
});
