import { CSRF_HEADER } from '@oralis/shared';
import { count, eq } from 'drizzle-orm';
import request from 'supertest';
import { subscriptions, webhookEvents } from '../src/db/schema';
import { BillingService } from '../src/modules/billing/billing.service';
import { StripeClient } from '../src/modules/billing/stripe.client';
import { JobsService } from '../src/modules/platform/jobs.service';
import { type Clinic, type TestContext, TZ, addMember, createClinic, createTestApp, resetDb } from './helpers';

const SECRET = 'whsec_teste_local_nao_e_real';

describe('Assinatura do SaaS, direitos do plano e exportação', () => {
  let t: TestContext;
  let c: Clinic;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  let seq = 0;
  const now = () => Math.floor(t.clock.now().getTime() / 1000);
  const send = (type: string, object: Record<string, unknown>, opts: { id?: string; created?: number; signature?: string } = {}) => {
    const body = JSON.stringify({ id: opts.id ?? `evt_${++seq}`, type, created: opts.created ?? now(), data: { object } });
    return request(t.app.getHttpServer())
      .post('/api/billing/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', opts.signature ?? StripeClient.sign(body, SECRET, now()))
      .send(body);
  };

  beforeAll(async () => {
    t = await createTestApp({ STRIPE_WEBHOOK_SECRET: SECRET });
    await resetDb(t.db);
    c = await createClinic(t.app, 'assinante@exemplo.test', 'Clínica Assinante', 'essencial');
  });
  afterAll(() => t.close());

  it('planos públicos vêm do catálogo central, sem preço definido ainda', async () => {
    const r = await request(t.app.getHttpServer()).get('/api/public/plans');
    expect(r.body.map((p: { key: string }) => p.key)).toEqual(['essencial', 'profissional', 'rede']);
    expect(r.body.every((p: { priceMonthly: string | null; purchasable: boolean }) => p.priceMonthly === null && !p.purchasable)).toBe(true);
  });

  it('organização nova começa em avaliação do plano escolhido no cadastro', async () => {
    const r = await c.owner.get(url('/billing'));
    expect(r.body.subscription.status).toBe('trial');
    expect(r.body.plan.key).toBe('essencial');
    expect(r.body.access.level).toBe('full');
  });

  it('limites do plano valem no backend (unidades e usuários)', async () => {
    const unit = await c.owner.post(url('/units'), { unit: { name: 'Segunda', timezone: TZ }, businessHours: [] });
    expect(unit.status).toBe(402);
    expect(unit.body.error.code).toBe('plan_limit');
    await addMember(t.app, c, 'membro2@exemplo.test', 'reception');
    await addMember(t.app, c, 'membro3@exemplo.test', 'reception');
    const roles = await c.owner.get(url('/roles'));
    const fourth = await c.owner.post(url('/invitations'), { email: 'membro4@exemplo.test', roleId: roles.body.find((x: { key: string }) => x.key === 'dentist').id, allUnits: true });
    expect(fourth.status).toBe(402);
  });

  it('prévia de troca mostra ganhos de recursos; contratação paga sem provedor é recusada com clareza', async () => {
    const p = await c.owner.post(url('/billing/change/preview'), { planKey: 'rede', interval: 'monthly' });
    expect(p.body.featuresGained.length).toBeGreaterThan(0);
    expect(p.body.exceeding).toEqual([]);
    const ck = await c.owner.post(url('/billing/checkout'), { planKey: 'rede', interval: 'monthly', acceptTerms: true });
    expect(ck.status).toBe(422);
    expect(ck.body.error.message).toMatch(/não está disponível/);
  });

  it('webhook com assinatura inválida é recusado e não grava nada', async () => {
    const r = await send('customer.subscription.updated', { id: 'sub_x' }, { signature: 't=1,v1=abc' });
    expect(r.status).toBe(403);
    const [{ n }] = (await t.db.select({ n: count() }).from(webhookEvents)) as [{ n: number }];
    expect(n).toBe(0);
  });

  describe('ciclo da assinatura pelo provedor', () => {
    const subObj = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'sub_123', customer: 'cus_1', status, cancel_at_period_end: false, current_period_end: now() + 30 * 86400, metadata: { organizationId: c.orgId }, items: { data: [{ id: 'si_1', price: { id: 'price_x' } }] }, ...extra });

    it('checkout concluído vincula a assinatura; só o evento do provedor ativa', async () => {
      await send('checkout.session.completed', { id: 'cs_1', client_reference_id: c.orgId, subscription: 'sub_123', customer: 'cus_1' });
      let s = (await c.owner.get(url('/billing'))).body.subscription;
      expect(s.status).toBe('trial');
      const r = await send('customer.subscription.updated', subObj('active'), { id: 'evt_active', created: now() });
      expect(r.status).toBe(200);
      s = (await c.owner.get(url('/billing'))).body.subscription;
      expect(s.status).toBe('active');
    });

    it('evento repetido não reprocessa; evento antigo fora de ordem é ignorado', async () => {
      const dup = await send('customer.subscription.updated', subObj('active'), { id: 'evt_active', created: now() });
      expect(dup.body.duplicate).toBe(true);
      const old = await send('customer.subscription.updated', subObj('past_due'), { created: now() - 3600 });
      expect(old.body.status).toBe('ignored');
      expect((await c.owner.get(url('/billing'))).body.subscription.status).toBe('active');
    });

    it('falha de pagamento: carência com acesso completo, depois somente leitura', async () => {
      await send('invoice.payment_failed', { id: 'in_1', customer: 'cus_1', subscription: 'sub_123', amount_due: 19900, currency: 'brl' });
      let b = (await c.owner.get(url('/billing'))).body;
      expect(b.subscription.status).toBe('past_due');
      expect(b.access.level).toBe('full');
      expect((await c.owner.post(url('/patients'), { fullName: 'Paciente na Carência' })).status).toBe(201);

      t.clock.set(new Date(t.clock.now().getTime() + 8 * 86_400_000).toISOString());
      await t.app.get(BillingService).evaluate();
      b = (await c.owner.get(url('/billing'))).body;
      expect(b.subscription.status).toBe('suspended');
      expect(b.access.level).toBe('read_only');
      const blocked = await c.owner.post(url('/patients'), { fullName: 'Bloqueado' });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error.code).toBe('subscription_inactive');
      expect((await c.owner.get(url('/patients'))).status).toBe(200);
    });

    it('exportação continua disponível no modo somente leitura e expira', async () => {
      const r = await c.owner.post(url('/exports'), { scope: 'patients' });
      expect(r.status).toBe(201);
      await t.app.get(JobsService).drain();
      const list = await c.owner.get(url('/exports'));
      expect(list.body[0]).toMatchObject({ status: 'ready', rowCount: 1 });
      const file = await c.owner.agent.get(`/api${url(`/exports/${r.body.id}/download`)}`).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (x: Buffer) => (d += x.toString())); res.on('end', () => cb(null, d)); });
      expect(file.headers['content-type']).toMatch(/text\/csv/);
      expect(String(file.body)).toContain('Paciente na Carência');
    });

    it('regularização reativa sem duplicar assinatura', async () => {
      await send('invoice.paid', { id: 'in_1', customer: 'cus_1', subscription: 'sub_123', amount_paid: 19900, currency: 'brl' });
      const b = (await c.owner.get(url('/billing'))).body;
      expect(b.subscription.status).toBe('active');
      expect(b.invoices).toHaveLength(1);
      expect(b.invoices[0].status).toBe('paid');
      expect((await c.owner.post(url('/patients'), { fullName: 'Depois da Regularização' })).status).toBe(201);
      const [{ n }] = (await t.db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.organizationId, c.orgId))) as [{ n: number }];
      expect(n).toBe(1);
      expect(b.history.some((h: { kind: string }) => h.kind === 'regularized')).toBe(true);
    });

    it('cancelamento com assinatura no provedor não é feito só no banco local', async () => {
      const r = await c.owner.post(url('/billing/cancel'), { reason: 'teste' });
      expect(r.status).toBe(422); // provedor não configurado: nada muda localmente
      expect((await c.owner.get(url('/billing'))).body.subscription.cancelAtPeriodEnd).toBe(false);
      await send('customer.subscription.deleted', { ...subObj('canceled'), id: 'sub_123' });
      const b = (await c.owner.get(url('/billing'))).body;
      expect(b.subscription.status).toBe('cancelled');
      expect(b.access.level).toBe('read_only');
    });
  });

  it('avaliação cancelada localmente e fim de avaliação viram somente leitura', async () => {
    t.clock.set('2030-03-12T13:00:00.000Z');
    const other = await createClinic(t.app, 'avaliacao@exemplo.test', 'Clínica Avaliação', 'profissional');
    const r = await other.owner.post(`/orgs/${other.orgId}/billing/cancel`, {});
    expect(r.body.subscription.status).toBe('cancelled');
    const third = await createClinic(t.app, 'fim-avaliacao@exemplo.test', 'Clínica Fim', 'profissional');
    t.clock.set('2030-04-01T13:00:00.000Z');
    await t.app.get(BillingService).evaluate();
    const b = (await third.owner.get(`/orgs/${third.orgId}/billing`)).body;
    expect(b.subscription).toMatchObject({ status: 'suspended' });
    expect(b.access.level).toBe('read_only');
    t.clock.set('2030-03-12T13:00:00.000Z');
  });

  it('exportação exige permissão própria', async () => {
    const recep = await addMember(t.app, await createClinic(t.app, 'exp@exemplo.test'), 'recep-exp@exemplo.test', 'reception');
    const me = await recep.client.get('/auth/me');
    const orgId = me.body.memberships[0].organizationId;
    expect((await recep.client.post(`/orgs/${orgId}/exports`, { scope: 'patients' })).status).toBe(403);
  });

  it('webhook não exige CSRF, mas rotas comuns continuam exigindo', async () => {
    const r = await request(t.app.getHttpServer()).post(`/api${url('/patients')}`).set(CSRF_HEADER, '0').send({ fullName: 'x' });
    expect(r.status).toBe(403);
  });
});
