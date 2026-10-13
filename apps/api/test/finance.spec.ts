import { sql } from 'drizzle-orm';
import { type Client, type Clinic, type TestContext, addMember, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

describe('Financeiro clínico — jornada C e regras de consistência', () => {
  let t: TestContext;
  let c: Clinic;
  let dentist: Client;
  let reception: Client;
  let finance: Client;
  let manager: Client;
  let patientId: string;
  let accountId: string;
  let recs: { id: string; amount: string; installmentNo: number }[] = [];
  let paymentId: string;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  const pay = (cl: Client, body: Record<string, unknown>) => cl.post(url('/finance/payments'), { cashAccountId: accountId, method: 'pix', receivedAt: '2030-03-12T10:00:00-03:00', ...body });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'clinica-fin@exemplo.test');
    const d = await addMember(t.app, c, 'dent-fin@exemplo.test', 'dentist');
    dentist = d.client;
    reception = (await addMember(t.app, c, 'recep-fin@exemplo.test', 'reception')).client;
    finance = (await addMember(t.app, c, 'fin-fin@exemplo.test', 'finance')).client;
    manager = (await addMember(t.app, c, 'gestor-fin@exemplo.test', 'manager')).client;
    await createProfessional(c, 'Dra. Financeiro', { membershipId: d.membershipId });
    patientId = await createPatient(reception, c.orgId, 'Paciente Financeiro');
    const accounts = await finance.get(url('/finance/accounts'));
    accountId = accounts.body[0].id;
  });
  afterAll(() => t.close());

  it('recepção e dentista não acessam o financeiro', async () => {
    expect((await reception.get(url('/finance/receivables'))).status).toBe(403);
    expect((await dentist.get(url('/finance/payments'))).status).toBe(403);
  });

  it('aprovação de orçamento gera parcelas com arredondamento na primeira', async () => {
    const plan = await dentist.post(url(`/patients/${patientId}/treatment-plans`), { unitId: c.unitId, title: 'Plano financeiro' });
    await dentist.post(url(`/treatment-plans/${plan.body.id}/items`), { description: 'Prótese', unitPrice: '1000.00' });
    const q = await dentist.post(url(`/treatment-plans/${plan.body.id}/present`), { installments: 3, method: 'pix', firstDueDate: '2030-03-10', validUntil: '2030-04-30' });
    await reception.post(url(`/quotes/${q.body.quoteId}/decision`), { versionId: q.body.versionId, decision: 'approved', generateReceivables: true });
    const list = await finance.get(url(`/finance/receivables?patientId=${patientId}`));
    recs = list.body;
    expect(recs.map((r) => r.amount)).toEqual(['333.34', '333.33', '333.33']);
    expect(list.body[0].view).toBe('overdue'); // venceu em 10/03, hoje é 12/03
  });

  it('recebimento parcial e depois quitação', async () => {
    const p1 = await pay(finance, { amount: '200.00', allocations: [{ receivableId: recs[0]!.id, amount: '200.00' }] });
    expect(p1.status).toBe(201);
    paymentId = p1.body.id;
    let r = (await finance.get(url(`/finance/receivables?patientId=${patientId}`))).body[0];
    expect(r).toMatchObject({ paid: '200.00', balance: '133.34', view: 'partial_overdue', status: 'open' });
    await pay(finance, { amount: '133.34', allocations: [{ receivableId: recs[0]!.id, amount: '133.34' }] });
    r = (await finance.get(url(`/finance/receivables?patientId=${patientId}`))).body[0];
    expect(r).toMatchObject({ balance: '0.00', status: 'paid', view: 'paid' });
  });

  it('não aloca mais que o saldo da parcela (garantido pelo banco)', async () => {
    const r = await pay(finance, { amount: '400.00', allocations: [{ receivableId: recs[1]!.id, amount: '400.00' }] });
    expect(r.status).toBe(422);
  });

  it('recebimentos simultâneos na mesma parcela: só o que cabe é aceito', async () => {
    const results = await Promise.all([1, 2].map(() => pay(finance, { amount: '300.00', allocations: [{ receivableId: recs[1]!.id, amount: '300.00' }] })));
    expect(results.map((x) => x.status).sort()).toEqual([201, 422]);
  });

  it('mesma chave de idempotência não duplica o recebimento', async () => {
    const body = { amount: '10.00', allocations: [{ receivableId: recs[2]!.id, amount: '10.00' }], idempotencyKey: 'chave-teste-1234' };
    const a = await pay(finance, body);
    const b = await pay(finance, body);
    expect(b.body).toEqual({ id: a.body.id, duplicate: true });
    const r = (await finance.get(url(`/finance/receivables?patientId=${patientId}`))).body[2];
    expect(r.paid).toBe('10.00');
  });

  it('estorno exige aprovação de outra pessoa e reabre o saldo da parcela', async () => {
    const req = await finance.post(url(`/finance/payments/${paymentId}/refunds`), { amount: '100.00', reason: 'Cobrança em duplicidade pelo cartão', receivableId: recs[0]!.id });
    expect(req.status).toBe(201);
    expect((await finance.post(url(`/finance/refunds/${req.body.id}/decision`), { approve: true })).status).toBe(403);
    expect((await manager.post(url(`/finance/refunds/${req.body.id}/decision`), { approve: true })).status).toBe(201);
    const r = (await finance.get(url(`/finance/receivables?patientId=${patientId}`))).body[0];
    expect(r).toMatchObject({ paid: '233.34', balance: '100.00', status: 'open' });
    const tooMuch = await finance.post(url(`/finance/payments/${paymentId}/refunds`), { amount: '150.00', reason: 'Excede o valor do recebimento' });
    expect(tooMuch.status).toBe(422);
  });

  it('alocações são imutáveis e parcela com recebimento não é cancelada', async () => {
    await expect(t.db.execute(sql`update payment_allocations set amount = 1`)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect((await finance.post(url(`/finance/receivables/${recs[0]!.id}/cancel`), { reason: 'teste' })).status).toBe(422);
  });

  it('despesas recorrentes, pagamento e fluxo de caixa previsto x realizado', async () => {
    const p = await finance.post(url('/finance/payables'), { unitId: c.unitId, description: 'Aluguel', amount: '2500.00', dueDate: '2030-03-15', repeatMonths: 3 });
    expect(p.body.ids).toHaveLength(3);
    await finance.post(url(`/finance/payables/${p.body.ids[0]}/pay`), { cashAccountId: accountId, paidAt: '2030-03-15T09:00:00-03:00' });
    const flow = await finance.get(url('/finance/reports/cashflow?from=2030-03-01&to=2030-04-30'));
    const mar15 = flow.body.find((d: { date: string }) => d.date === '2030-03-15');
    expect(mar15.actualOut).toBe('2500.00');
    const apr15 = flow.body.find((d: { date: string }) => d.date === '2030-04-15');
    expect(apr15.expectedOut).toBe('2500.00');
  });

  it('resumo separa contratado, cobrado, recebido e reconhecido, com definições', async () => {
    const s = await finance.get(url('/finance/reports/summary?from=2030-03-01&to=2030-03-31'));
    expect(s.body.contracted.value).toBe('1000.00');
    expect(s.body.charged.value).toBe('333.34');
    // 200 + 133.34 + 300 + 10 recebidos − 100 estornados
    expect(s.body.received.value).toBe('543.34');
    expect(s.body.recognized.value).toBe('0.00');
    expect(s.body.received.definition).toMatch(/estornos/);
  });

  it('conciliação: importação idempotente e vínculo com o recebimento', async () => {
    const csv = 'data;descrição;valor\n12/03/2030;PIX RECEBIDO PACIENTE;200,00\n15/03/2030;ALUGUEL;-2.500,00\nlinha inválida';
    const first = await finance.post(url(`/finance/accounts/${accountId}/statement`), { csv });
    expect(first.body).toMatchObject({ read: 2, inserted: 2, errors: [{ line: 4 }] });
    const again = await finance.post(url(`/finance/accounts/${accountId}/statement`), { csv });
    expect(again.body).toMatchObject({ inserted: 0, duplicates: 2 });
    const rec = await finance.get(url(`/finance/accounts/${accountId}/reconciliation`));
    const line = rec.body.lines.find((l: { amount: string }) => l.amount === '200.00');
    expect(line.suggestions[0]).toMatchObject({ kind: 'payment', id: paymentId });
    expect((await finance.post(url(`/finance/statement-lines/${line.id}/match`), { kind: 'payment', id: paymentId })).status).toBe(201);
    const out = rec.body.lines.find((l: { amount: string }) => l.amount === '-2500.00');
    expect(out.suggestions[0].kind).toBe('payable');
  });

  it('outra organização não movimenta parcelas desta', async () => {
    const other = await createClinic(t.app, 'outra-fin@exemplo.test');
    const acc = (await other.owner.get(`/orgs/${other.orgId}/finance/accounts`)).body[0].id;
    const r = await other.owner.post(`/orgs/${other.orgId}/finance/payments`, { cashAccountId: acc, amount: '10.00', method: 'pix', receivedAt: '2030-03-12T10:00:00-03:00', allocations: [{ receivableId: recs[2]!.id, amount: '10.00' }] });
    expect(r.status).toBe(404);
  });
});
