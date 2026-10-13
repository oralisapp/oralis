import { and, count, eq, like, sql } from 'drizzle-orm';
import { communicationEvents, organizations, tasks } from '../src/db/schema';
import { AutomationsService } from '../src/modules/engagement/automations.service';
import { JobsService } from '../src/modules/platform/jobs.service';
import { type Client, type Clinic, type TestContext, TZ, TODAY, addMember, at, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

describe('Relacionamento, automações, estoque e laboratórios', () => {
  let t: TestContext;
  let c: Clinic;
  let dentist: Client;
  let reception: Client;
  let prof: string;
  let p1: string;
  let p2: string;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  const drain = () => t.app.get(JobsService).drain();
  const countEvents = async () => ((await t.db.select({ n: count() }).from(communicationEvents)) as [{ n: number }])[0].n;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'clinica-ops@exemplo.test');
    const d = await addMember(t.app, c, 'dent-ops@exemplo.test', 'dentist');
    dentist = d.client;
    reception = (await addMember(t.app, c, 'recep-ops@exemplo.test', 'reception')).client;
    prof = await createProfessional(c, 'Dra. Ops', { membershipId: d.membershipId });
    p1 = await createPatient(c.owner, c.orgId, 'Paciente Um Ops', { email: 'um@ops.example' });
    p2 = await createPatient(c.owner, c.orgId, 'Paciente Dois Ops', { email: 'dois@ops.example' });
  });
  afterAll(() => t.close());
  beforeEach(() => t.clock.set('2030-03-12T13:00:00.000Z'));

  describe('comunicações', () => {
    let relId: string;
    it('modelo recusa campos desconhecidos e cria versões', async () => {
      expect((await c.owner.post(url('/messaging/templates'), { name: 'X', category: 'relationship', channel: 'email', body: 'Oi {{cpf}}' })).status).toBe(422);
      const r = await c.owner.post(url('/messaging/templates'), { name: 'Retorno', category: 'relationship', channel: 'email', subject: 'Retorno', body: 'Olá, {{primeiro_nome}}! Que tal agendar seu retorno em {{clinica}}?' });
      relId = r.body.id;
      const v2 = await c.owner.put(url(`/messaging/templates/${relId}`), { name: 'Retorno', category: 'relationship', channel: 'email', body: 'Olá, {{primeiro_nome}}! Vamos agendar seu retorno?' });
      expect(v2.body.version).toBe(2);
      relId = v2.body.id;
    });

    it('pré-visualização mostra a mensagem final e se há autorização', async () => {
      const r = await c.owner.post(url('/messaging/preview'), { templateId: relId, patientId: p1 });
      expect(r.body.body).toBe('Olá, Paciente! Vamos agendar seu retorno?');
      expect(r.body.consent).toBe(false); // relacionamento exige autorização explícita
    });

    it('sem autorização a mensagem é bloqueada e registrada; com autorização segue', async () => {
      expect((await c.owner.post(url('/messaging/send'), { templateId: relId, patientId: p1 })).body.status).toBe('blocked_consent');
      await c.owner.put(url(`/patients/${p1}/communication`), { preferences: [{ channel: 'email', category: 'relationship', allowed: true }, { channel: 'whatsapp', category: 'relationship', allowed: true }] });
      expect((await c.owner.post(url('/messaging/send'), { templateId: relId, patientId: p1 })).body.status).toBe('logged_locally');
    });

    it('WhatsApp sem provedor nunca aparece como enviado', async () => {
      const w = await c.owner.post(url('/messaging/templates'), { name: 'Zap', category: 'relationship', channel: 'whatsapp', body: 'Olá {{primeiro_nome}}' });
      expect((await c.owner.post(url('/messaging/send'), { templateId: w.body.id, patientId: p1 })).body.status).toBe('not_configured');
    });

    it('limite de frequência semanal para mensagens não transacionais', async () => {
      await c.owner.post(url('/messaging/send'), { templateId: relId, patientId: p1 });
      await c.owner.post(url('/messaging/send'), { templateId: relId, patientId: p1 });
      expect((await c.owner.post(url('/messaging/send'), { templateId: relId, patientId: p1 })).body.status).toBe('blocked_frequency');
    });

    it('campanha exige confirmar a contagem exibida na prévia', async () => {
      const promo = await c.owner.post(url('/messaging/templates'), { name: 'Novidade', category: 'promotional', channel: 'email', body: 'Novidade na {{clinica}}' });
      await c.owner.put(url(`/patients/${p2}/communication`), { preferences: [{ channel: 'email', category: 'promotional', allowed: true }] });
      const pv = await c.owner.post(url('/messaging/campaigns/preview'), { templateId: promo.body.id, criteria: {} });
      expect(pv.body).toMatchObject({ matched: 2, withConsent: 1, withoutConsent: 1 });
      expect((await c.owner.post(url('/messaging/campaigns'), { name: 'Teste', templateId: promo.body.id, criteria: {}, confirmRecipientCount: 2 })).status).toBe(409);
      const ok = await c.owner.post(url('/messaging/campaigns'), { name: 'Teste', templateId: promo.body.id, criteria: {}, confirmRecipientCount: 1 });
      expect(ok.body.result).toEqual({ logged_locally: 1 });
    });

    it('organização de demonstração nunca envia', async () => {
      await t.db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, c.orgId));
      const tpl = (await c.owner.get(url('/messaging/templates'))).body.find((x: { name: string }) => x.name === 'Novidade');
      expect((await c.owner.post(url('/messaging/send'), { templateId: tpl.id, patientId: p2 })).body.status).toBe('blocked_demo');
      await t.db.update(organizations).set({ isDemo: false }).where(eq(organizations.id, c.orgId));
    });
  });

  describe('CRM', () => {
    it('funil com motivo de perda obrigatório e conversão em paciente', async () => {
      const l = await reception.post(url('/crm/leads'), { name: 'Contato Novo Ops', source: 'instagram', phone: '11988887777' });
      expect((await reception.put(url(`/crm/leads/${l.body.id}/stage`), { stage: 'lost' })).status).toBe(422);
      expect((await reception.put(url(`/crm/leads/${l.body.id}/stage`), { stage: 'evaluation_scheduled' })).status).toBe(200);
      const conv = await reception.post(url(`/crm/leads/${l.body.id}/convert`));
      expect((await reception.get(url(`/patients/${conv.body.patientId}`))).body.patient.fullName).toBe('Contato Novo Ops');
      const board = await reception.get(url('/crm/board'));
      expect(board.body.counts.evaluation_scheduled).toBe(1);
      expect(board.body.conversion.definition).toBeTruthy();
    });

    it('recurso fora do plano é bloqueado no backend', async () => {
      const small = await createClinic(t.app, 'essencial-ops@exemplo.test', 'Clínica Essencial', 'essencial');
      const r = await small.owner.get(`/orgs/${small.orgId}/crm/board`);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('feature_disabled');
      expect((await small.owner.get(`/orgs/${small.orgId}/automations`)).status).toBe(403);
    });
  });

  describe('automações', () => {
    let autoId: string;
    let apptId: string;

    it('simulação sintética explica seleção e exclusões sem efeitos', async () => {
      const before = await countEvents();
      const r = await c.owner.post(url('/automations/simulate'), { mode: 'synthetic', templateKey: 'confirmation', config: { hoursBefore: 24 }, channel: 'email' });
      expect(r.body.selected.map((x: { label: string }) => x.label.split(' — ')[0])).toEqual(['Paciente Fictício A']);
      expect(r.body.excluded).toHaveLength(3);
      expect(r.body.excluded.flatMap((x: { reasons: string[] }) => x.reasons).join(' ')).toMatch(/não autoriza/);
      expect(await countEvents()).toBe(before);
    });

    it('automação nasce pausada; ativa, envia uma vez por versão da consulta', async () => {
      apptId = (await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId: p2, professionalId: prof, startsAt: at('2030-03-13', '09:00'), durationMinutes: 30 })).body.id;
      const a = await c.owner.post(url('/automations'), { templateKey: 'confirmation', name: 'Confirmar 24h antes', config: { hoursBefore: 24 }, channel: 'email', windowStart: '07:00', windowEnd: '21:00' });
      autoId = a.body.id;
      expect(a.body.status).toBe('paused');
      const svc = t.app.get(AutomationsService);
      expect(await svc.tick()).toBe(0);
      await c.owner.put(url(`/automations/${autoId}/status`), { status: 'active' });
      expect(await svc.tick()).toBe(1);
      expect(await svc.tick()).toBe(0); // dedupe
      const ev = await t.db.select().from(communicationEvents).where(eq(communicationEvents.automationId, autoId));
      expect(ev).toHaveLength(1);
      expect(ev[0]!.body).toContain('/c/');
      expect(ev[0]!.body).not.toMatch(/serviço|procedimento/i);
    });

    it('fora da janela de horário não age; consulta já confirmada não é selecionada', async () => {
      const svc = t.app.get(AutomationsService);
      t.clock.set('2030-03-13T02:00:00.000Z'); // 23:00 local
      const other = (await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId: p1, professionalId: prof, startsAt: at('2030-03-13', '11:00'), durationMinutes: 30 })).body.id;
      expect(await svc.tick()).toBe(0);
      t.clock.set('2030-03-12T13:00:00.000Z');
      await c.owner.post(url(`/appointments/${other}/transitions`), { to: 'confirmed', version: 1 });
      expect(await svc.tick()).toBe(0);
      const h = await c.owner.get(url(`/automations/${autoId}/history`));
      expect(h.body.versions).toHaveLength(1);
      expect(h.body.executions.filter((e: { status: string }) => e.status === 'done')).toHaveLength(1);
    });

    it('vaga aberta: cancelamento gera tarefa com candidatos, sem reservar', async () => {
      await c.owner.post(url('/automations'), { templateKey: 'vacancy', name: 'Vaga aberta', config: {} }).then((r) => c.owner.put(url(`/automations/${r.body.id}/status`), { status: 'active' }));
      await reception.post(url('/waitlist'), { patientId: p1, durationMinutes: 30 });
      await reception.post(url(`/appointments/${apptId}/transitions`), { to: 'cancelled', reason: 'patient_request', version: 1 });
      await drain();
      const ts = await t.db.select().from(tasks).where(and(eq(tasks.relatedId, apptId), eq(tasks.origin, 'automation')));
      expect(ts).toHaveLength(1);
      expect(ts[0]!.title).toMatch(/Vaga aberta/);
    });
  });

  describe('estoque', () => {
    let itemId: string;
    let parque: string;

    it('saldo nunca fica negativo; ajuste exige motivo; movimentação é imutável', async () => {
      itemId = (await c.owner.post(url('/inventory/items'), { name: 'Resina A2', unitMeasure: 'seringa', minQuantity: '5' })).body.id;
      expect((await c.owner.post(url('/inventory/movements'), { itemId, unitId: c.unitId, type: 'in', quantity: '10', lotCode: 'L1', expiresOn: '2030-04-01', unitCost: '45.00' })).status).toBe(201);
      expect((await c.owner.post(url('/inventory/movements'), { itemId, unitId: c.unitId, type: 'out', quantity: '11' })).status).toBe(422);
      expect((await c.owner.post(url('/inventory/movements'), { itemId, unitId: c.unitId, type: 'adjust_out', quantity: '1' })).status).toBe(422);
      expect((await c.owner.post(url('/inventory/movements'), { itemId, unitId: c.unitId, type: 'adjust_out', quantity: '1', reason: 'Seringa danificada' })).status).toBe(201);
      await expect(t.db.execute(sql`update stock_movements set quantity = 99`)).rejects.toMatchObject({ cause: { code: '42501' } });
    });

    it('estoque abaixo do mínimo gera alerta de reposição (automação), sem compra', async () => {
      const a = await c.owner.post(url('/automations'), { templateKey: 'stock_minimum', name: 'Estoque mínimo', config: {} });
      await c.owner.put(url(`/automations/${a.body.id}/status`), { status: 'active' });
      await c.owner.post(url('/inventory/movements'), { itemId, unitId: c.unitId, type: 'out', quantity: '5' });
      await drain();
      const ts = await t.db.select().from(tasks).where(and(eq(tasks.relatedId, itemId), like(tasks.title, 'Repor estoque%')));
      expect(ts).toHaveLength(1);
      const al = await c.owner.get(url('/inventory/alerts'));
      expect(al.body.reorder[0]).toMatchObject({ balance: 4, min: 5, suggested: 6 });
      expect(al.body.expiring[0].lotCode).toBe('L1');
    });

    it('transferência entre unidades e baixa automática ao concluir procedimento', async () => {
      parque = (await c.owner.post(url('/units'), { unit: { name: 'Parque Ops', timezone: TZ }, businessHours: [{ weekday: 2, opensAt: '08:00', closesAt: '18:00' }] })).body.id;
      expect((await c.owner.post(url('/inventory/transfers'), { itemId, fromUnitId: c.unitId, toUnitId: parque, quantity: '2' })).status).toBe(201);
      const svc = (await c.owner.post(url('/services'), { name: 'Restauração Ops', durationMinutes: 30 })).body.id;
      await c.owner.post(url('/inventory/materials'), { serviceId: svc, itemId, quantity: '1' });
      const a = await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId: p1, professionalId: prof, serviceId: svc, startsAt: at(TODAY, '15:00'), durationMinutes: 30 });
      await c.owner.post(url(`/appointments/${a.body.id}/transitions`), { to: 'arrived', version: 1 });
      await dentist.post(url(`/appointments/${a.body.id}/transitions`), { to: 'in_progress', version: 2 });
      await dentist.post(url(`/appointments/${a.body.id}/transitions`), { to: 'completed', version: 3 });
      const items = (await c.owner.get(url('/inventory/items'))).body;
      const balances = items.find((i: { id: string }) => i.id === itemId).perUnit;
      expect(balances.find((b: { unitId: string }) => b.unitId === c.unitId).balance).toBe(1);
      expect(balances.find((b: { unitId: string }) => b.unitId === parque).balance).toBe(2);
    });
  });

  describe('laboratórios — jornada E', () => {
    it('pedido ligado à etapa do plano: recebido gera tarefa para agendar a próxima sessão', async () => {
      const plan = (await dentist.post(url(`/patients/${p2}/treatment-plans`), { unitId: c.unitId, title: 'Prótese' })).body.id;
      const item = (await dentist.post(url(`/treatment-plans/${plan}/items`), { description: 'Coroa', tooth: 36, unitPrice: '1200.00' })).body.id;
      const q = await dentist.post(url(`/treatment-plans/${plan}/present`), { installments: 1, firstDueDate: '2030-03-20', validUntil: '2030-04-30' });
      await reception.post(url(`/quotes/${q.body.quoteId}/decision`), { versionId: q.body.versionId, decision: 'approved', generateReceivables: false, createSchedulingTasks: false });
      const lab = (await dentist.post(url('/labs'), { name: 'Laboratório Fictício' })).body.id;
      const o = await dentist.post(url('/labs/orders'), { unitId: c.unitId, patientId: p2, laboratoryId: lab, professionalId: prof, treatmentItemId: item, work: 'Coroa metalocerâmica 36', shade: 'A2', dueDate: '2030-03-19' });
      expect(o.status).toBe(201);
      expect((await dentist.post(url(`/labs/orders/${o.body.id}/status`), { to: 'delivered' })).status).toBe(422);
      await dentist.post(url(`/labs/orders/${o.body.id}/status`), { to: 'sent' });
      t.clock.set('2030-03-21T13:00:00.000Z');
      const late = (await dentist.get(url('/labs/orders?status=open'))).body[0];
      expect(late.late).toBe(true);
      await dentist.post(url(`/labs/orders/${o.body.id}/status`), { to: 'received' });
      const ts = await t.db.select().from(tasks).where(eq(tasks.relatedId, o.body.id));
      expect(ts.some((x) => /agendar/.test(x.title))).toBe(true);
      const sheet = (await dentist.get(url(`/labs/orders/${o.body.id}/sheet`))).body;
      expect(sheet.patient).toBe('Paciente D. O.');
    });
  });
});
