import { eq, sql } from 'drizzle-orm';
import { tasks, treatmentItems, treatmentPlans } from '../src/db/schema';
import { type Client, type Clinic, type TestContext, TODAY, addMember, at, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

describe('Odontograma, planos de tratamento e orçamentos', () => {
  let t: TestContext;
  let c: Clinic;
  let dentist: Client;
  let reception: Client;
  let profId: string;
  let patientId: string;
  let planId: string;
  let item1: string;
  let item2: string;
  let quoteId: string;
  let v1: string;
  let v2: string;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'clinica-trat@exemplo.test');
    const d = await addMember(t.app, c, 'dentista-trat@exemplo.test', 'dentist');
    dentist = d.client;
    reception = (await addMember(t.app, c, 'recep-trat@exemplo.test', 'reception')).client;
    profId = await createProfessional(c, 'Dr. Plano', { membershipId: d.membershipId });
    patientId = await createPatient(reception, c.orgId, 'Paciente do Plano');
  });
  afterAll(() => t.close());

  describe('odontograma', () => {
    it('registra por dente e superfície e mantém histórico ao substituir', async () => {
      expect((await dentist.post(url(`/patients/${patientId}/odontogram`), { tooth: 36, surfaces: ['O'], condition: 'caries', status: 'existing' })).status).toBe(201);
      const r = await dentist.post(url(`/patients/${patientId}/odontogram`), { tooth: 36, surfaces: ['O', 'V'], condition: 'restoration', status: 'existing' });
      expect(r.body.superseded).toBe(1);
      const chart = await dentist.get(url(`/patients/${patientId}/odontogram`));
      expect(chart.body.current.filter((e: { tooth: number }) => e.tooth === 36)).toHaveLength(1);
      expect(chart.body.history.filter((e: { tooth: number }) => e.tooth === 36)).toHaveLength(2);
    });

    it('recusa numeração dentária inválida e impede apagar histórico no banco', async () => {
      expect((await dentist.post(url(`/patients/${patientId}/odontogram`), { tooth: 19, condition: 'caries', status: 'existing' })).status).toBe(422);
      await expect(t.db.execute(sql`delete from odontogram_entries`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(t.db.execute(sql`update odontogram_entries set condition = 'other'`)).rejects.toMatchObject({ cause: { code: '42501' } });
    });

    it('recepção não acessa o odontograma', async () => {
      expect((await reception.get(url(`/patients/${patientId}/odontogram`))).status).toBe(403);
    });
  });

  describe('plano e orçamento', () => {
    it('recepção não monta plano; dentista monta com etapas', async () => {
      expect((await reception.post(url(`/patients/${patientId}/treatment-plans`), { unitId: c.unitId, title: 'X' })).status).toBe(403);
      const p = await dentist.post(url(`/patients/${patientId}/treatment-plans`), { unitId: c.unitId, title: 'Reabilitação', objective: 'Recuperar a mastigação do lado esquerdo.', responsibleProfessionalId: profId });
      planId = p.body.id;
      item1 = (await dentist.post(url(`/treatment-plans/${planId}/items`), { description: 'Tratamento de canal', tooth: 46, stage: 1, unitPrice: '650.00' })).body.id;
      item2 = (await dentist.post(url(`/treatment-plans/${planId}/items`), { description: 'Coroa', tooth: 46, stage: 2, unitPrice: '1200.00', dependsOnItemId: item1 })).body.id;
      const chart = await dentist.get(url(`/patients/${patientId}/odontogram`));
      // Etapas diferentes no mesmo dente coexistem como planejadas.
      expect(chart.body.current.filter((e: { status: string; tooth: number }) => e.status === 'planned' && e.tooth === 46).map((e: { condition: string }) => e.condition).sort()).toEqual(['crown', 'root_canal']);
    });

    it('desconto acima de 10% exige gestor; desconto exige motivo', async () => {
      const base = { installments: 3, method: 'pix', firstDueDate: '2030-03-20', validUntil: '2030-04-12' };
      expect((await dentist.post(url(`/treatment-plans/${planId}/present`), { ...base, discount: '400.00', discountReason: 'Campanha' })).status).toBe(403);
      expect((await dentist.post(url(`/treatment-plans/${planId}/present`), { ...base, discount: '50.00' })).status).toBe(422);
      const ok = await dentist.post(url(`/treatment-plans/${planId}/present`), { ...base, discount: '50.00', discountReason: 'Pagamento à vista da entrada' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ version: 1, total: '1800.00' });
      quoteId = ok.body.quoteId;
      v1 = ok.body.versionId;
    });

    it('versão apresentada é imutável', async () => {
      await expect(t.db.execute(sql`update quote_versions set total = 1`)).rejects.toMatchObject({ cause: { code: '42501' } });
    });

    it('alterar o plano depois de apresentado exige nova versão; aprovação deve apontar a versão vigente', async () => {
      await dentist.put(url(`/treatment-items/${item2}`), { unitPrice: '1100.00' });
      const [plan] = await t.db.select().from(treatmentPlans).where(eq(treatmentPlans.id, planId));
      expect(plan!.status).toBe('draft');
      const again = await dentist.post(url(`/treatment-plans/${planId}/present`), { installments: 3, method: 'pix', firstDueDate: '2030-03-20', validUntil: '2030-04-12' });
      expect(again.body.version).toBe(2);
      expect(again.body.quoteId).toBe(quoteId);
      v2 = again.body.versionId;
      const stale = await reception.post(url(`/quotes/${quoteId}/decision`), { versionId: v1, decision: 'approved' });
      expect(stale.status).toBe(409);
      const ok = await reception.post(url(`/quotes/${quoteId}/decision`), { versionId: v2, decision: 'approved', acknowledgedName: 'Paciente do Plano', generateReceivables: false });
      expect(ok.status).toBe(201);
      const detail = await reception.get(url(`/treatment-plans/${planId}`));
      expect(detail.body.plan.status).toBe('approved');
      expect(detail.body.quotes[0].decisions[0]).toMatchObject({ versionId: v2, via: 'clinic' });
      // Aprovação não executa nada: etapas continuam planejadas.
      expect(detail.body.items.every((i: { status: string }) => i.status === 'planned')).toBe(true);
    });

    it('aprovação gera tarefa de agendamento apenas para a primeira etapa', async () => {
      const ts = await t.db.select().from(tasks).where(eq(tasks.relatedId, planId));
      expect(ts.map((x) => x.title)).toEqual(['Agendar: Tratamento de canal — Paciente do Plano']);
    });

    it('continuidade aponta plano aprovado sem sessão agendada', async () => {
      const r = await reception.get(url('/treatment-plans/continuity'));
      const p = r.body.plans.find((x: { id: string }) => x.id === planId);
      expect(p.pending.map((x: { code: string }) => x.code)).toContain('approved_without_session');
    });
  });

  describe('execução do plano', () => {
    let apptId: string;

    it('agendar uma etapa a marca como agendada; cancelar devolve para planejada', async () => {
      const a = await reception.post(url('/appointments'), { unitId: c.unitId, patientId, professionalId: profId, startsAt: at('2030-03-14', '10:00'), durationMinutes: 60, treatmentItemId: item1 });
      expect(a.status).toBe(201);
      let [it1] = await t.db.select().from(treatmentItems).where(eq(treatmentItems.id, item1));
      expect(it1!.status).toBe('scheduled');
      await reception.post(url(`/appointments/${a.body.id}/transitions`), { to: 'cancelled', reason: 'patient_request', version: 1 });
      [it1] = await t.db.select().from(treatmentItems).where(eq(treatmentItems.id, item1));
      expect(it1!.status).toBe('planned');
    });

    it('não agenda etapa de outro paciente', async () => {
      const other = await createPatient(reception, c.orgId, 'Outro Paciente Plano');
      const r = await reception.post(url('/appointments'), { unitId: c.unitId, patientId: other, professionalId: profId, startsAt: at('2030-03-15', '10:00'), durationMinutes: 60, treatmentItemId: item1 });
      expect(r.status).toBe(422);
    });

    it('procedimento na evolução finalizada conclui a etapa, atualiza o odontograma e o progresso do plano', async () => {
      const a = await reception.post(url('/appointments'), { unitId: c.unitId, patientId, professionalId: profId, startsAt: at(TODAY, '15:00'), durationMinutes: 60, treatmentItemId: item1 });
      apptId = a.body.id;
      await reception.post(url(`/appointments/${apptId}/transitions`), { to: 'arrived', version: 1 });
      await dentist.post(url(`/appointments/${apptId}/transitions`), { to: 'in_progress', version: 2 });
      const w = await dentist.get(url(`/appointments/${apptId}/workspace`));
      expect(w.body.treatmentItems.map((i: { id: string }) => i.id)).toContain(item1);
      const rec = w.body.records[0];
      const saved = await dentist.put(url(`/clinical-records/${rec.id}`), { content: 'Tratamento endodôntico do 46 concluído.', procedures: [{ description: 'Tratamento de canal', tooth: 46, treatmentItemId: item1 }], version: rec.version });
      await dentist.post(url(`/clinical-records/${rec.id}/finalize`), { version: saved.body.version });
      const detail = await dentist.get(url(`/treatment-plans/${planId}`));
      expect(detail.body.items.find((i: { id: string }) => i.id === item1).status).toBe('done');
      expect(detail.body.plan.status).toBe('in_progress');
      const chart = await dentist.get(url(`/patients/${patientId}/odontogram`));
      expect(chart.body.current.some((e: { tooth: number; status: string; condition: string }) => e.tooth === 46 && e.status === 'done' && e.condition === 'root_canal')).toBe(true);
      const cont = await reception.get(url('/treatment-plans/continuity'));
      const p = cont.body.plans.find((x: { id: string }) => x.id === planId);
      expect(p.progress).toEqual({ done: 1, total: 2 });
      expect(p.pending.map((x: { code: string }) => x.code)).toContain('no_next_session');
    });
  });

  it('orçamento vencido não pode ser aprovado', async () => {
    const p = await dentist.post(url(`/patients/${patientId}/treatment-plans`), { unitId: c.unitId, title: 'Clareamento' });
    await dentist.post(url(`/treatment-plans/${p.body.id}/items`), { description: 'Clareamento de consultório', unitPrice: '900.00' });
    const q = await dentist.post(url(`/treatment-plans/${p.body.id}/present`), { installments: 1, firstDueDate: '2030-03-15', validUntil: '2030-03-13' });
    t.clock.set('2030-03-20T13:00:00.000Z');
    const r = await reception.post(url(`/quotes/${q.body.quoteId}/decision`), { versionId: q.body.versionId, decision: 'approved' });
    expect(r.status).toBe(422);
    const rej = await reception.post(url(`/quotes/${q.body.quoteId}/decision`), { versionId: q.body.versionId, decision: 'rejected' });
    expect(rej.status).toBe(422); // recusa exige motivo
    t.clock.set('2030-03-12T13:00:00.000Z');
  });
});
