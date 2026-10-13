import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, notFound } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { type AuthContext, type RequestMeta, type TenantContext } from '../../common/request-context';
import { env } from '../../config/env';
import { DB, type Db, type DbOrTx, type Tx } from '../../db/db';
import { billingInvoices, clinicUnits, documentVersions, invitations, memberships, organizations, plans, subscriptionChanges, subscriptions, termsAcceptances, users, webhookEvents } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { FEATURE_LABEL, GRACE_DAYS, READ_ONLY_DAYS, TERMS_VERSION, accessFor } from './entitlements';
import { StripeClient, type StripeSubscription } from './stripe.client';

const DAY = 86_400_000;
export const checkoutSchema = z.object({ planKey: z.string().min(2).max(40), interval: z.enum(['monthly', 'annual']), acceptTerms: z.literal(true, { error: 'É preciso aceitar os termos da contratação.' }) });
export const changePlanSchema = z.object({ planKey: z.string().min(2).max(40), interval: z.enum(['monthly', 'annual']) });

/** Cria a assinatura de avaliação de uma organização nova (usado no cadastro). */
export async function createTrialSubscription(tx: DbOrTx, organizationId: string, planKey: string | undefined, now: Date) {
  const [plan] = await tx.select().from(plans).where(and(eq(plans.key, planKey ?? 'profissional'), eq(plans.active, true)));
  const chosen = plan ?? (await tx.select().from(plans).where(eq(plans.key, 'profissional')))[0];
  if (!chosen) return;
  await tx.insert(subscriptions).values({ organizationId, planId: chosen.id, status: 'trial', trialEndsAt: new Date(now.getTime() + chosen.trialDays * DAY) }).onConflictDoNothing();
  await tx.insert(subscriptionChanges).values({ organizationId, kind: 'trial_started', toState: { plan: chosen.key, trialDays: chosen.trialDays }, source: 'system' });
}

/** Uso atual da organização, comparável aos limites do plano. */
export async function usageOf(db: DbOrTx, organizationId: string) {
  const [[u], [m], [i], [s]] = await Promise.all([
    db.select({ n: count() }).from(clinicUnits).where(and(eq(clinicUnits.organizationId, organizationId), eq(clinicUnits.active, true))),
    db.select({ n: count() }).from(memberships).where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, 'active'))),
    db.select({ n: count() }).from(invitations).where(and(eq(invitations.organizationId, organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))),
    db.select({ bytes: sql<string>`coalesce(sum(${documentVersions.sizeBytes}), 0)` }).from(documentVersions).where(eq(documentVersions.organizationId, organizationId)),
  ]);
  return { units: u?.n ?? 0, users: (m?.n ?? 0) + (i?.n ?? 0), storageMb: Math.ceil(Number(s?.bytes ?? 0) / 1024 / 1024) };
}

/**
 * Aplica o limite do plano NO BACKEND antes de criar unidade, convite ou
 * arquivo. Mensagem explica o limite e o caminho (trocar de plano).
 */
export async function assertWithinLimit(db: DbOrTx, organizationId: string, kind: 'units' | 'users' | 'storageMb', adding = 1) {
  const [row] = await db.select({ plan: plans }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.organizationId, organizationId));
  if (!row) return;
  const limit = kind === 'units' ? row.plan.maxUnits : kind === 'users' ? row.plan.maxUsers : row.plan.storageMb;
  if (limit === null) return;
  const usage = await usageOf(db, organizationId);
  if (usage[kind] + adding > limit) {
    const what = { units: 'unidades', users: 'usuários (incluindo convites pendentes)', storageMb: 'MB de armazenamento' }[kind];
    throw new AppError('plan_limit', `O plano ${row.plan.name} permite até ${limit} ${what}. Veja as opções em Assinatura.`, { kind, limit, usage: usage[kind] });
  }
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly stripe: StripeClient,
  ) {}

  async publicPlans() {
    const rows = await this.db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.sortOrder));
    return rows.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      priceMonthly: p.priceMonthly,
      priceAnnual: p.priceAnnual,
      currency: p.currency,
      maxUnits: p.maxUnits,
      maxUsers: p.maxUsers,
      storageMb: p.storageMb,
      features: p.features.map((f) => ({ key: f, label: FEATURE_LABEL[f] ?? f })),
      trialDays: p.trialDays,
      commercialTerms: p.commercialTerms,
      purchasable: !!(p.priceMonthly && p.stripePriceMonthly) || !!(p.priceAnnual && p.stripePriceAnnual),
    }));
  }

  private async load(db: DbOrTx, organizationId: string) {
    const [row] = await db.select({ sub: subscriptions, plan: plans }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.organizationId, organizationId));
    if (!row) throw notFound('Assinatura');
    return row;
  }

  async overview(tenant: TenantContext) {
    const { sub, plan } = await this.load(this.db, tenant.organizationId);
    const [usage, invoices, history] = await Promise.all([
      usageOf(this.db, tenant.organizationId),
      this.db.select().from(billingInvoices).where(eq(billingInvoices.organizationId, tenant.organizationId)).orderBy(desc(billingInvoices.createdAt)).limit(24),
      this.db.select({ c: subscriptionChanges, actorName: users.name }).from(subscriptionChanges).leftJoin(users, eq(users.id, subscriptionChanges.actorUserId)).where(eq(subscriptionChanges.organizationId, tenant.organizationId)).orderBy(desc(subscriptionChanges.createdAt)).limit(50),
    ]);
    const access = accessFor(sub, this.clock.now());
    const price = sub.interval === 'annual' ? plan.priceAnnual : plan.priceMonthly;
    return {
      subscription: { status: sub.status, statusReason: sub.statusReason, interval: sub.interval, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, graceUntil: sub.graceUntil, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, readOnlyUntil: sub.readOnlyUntil, provider: sub.provider, pendingCheckout: sub.pendingCheckout },
      plan: { key: plan.key, name: plan.name, price, currency: plan.currency, limits: { units: plan.maxUnits, users: plan.maxUsers, storageMb: plan.storageMb }, features: plan.features.map((f) => ({ key: f, label: FEATURE_LABEL[f] ?? f })) },
      usage,
      access,
      invoices,
      history: history.map((h) => ({ ...h.c, actorName: h.actorName })),
      providerConfigured: this.stripe.configured,
      policy: {
        graceDays: GRACE_DAYS,
        readOnlyDays: READ_ONLY_DAYS,
        text: `Em caso de falha de pagamento, o acesso continua completo por ${GRACE_DAYS} dias. Depois disso, ou após cancelamento ou fim da avaliação, a clínica mantém acesso de leitura e exportação dos dados por pelo menos ${READ_ONLY_DAYS} dias. Registros clínicos não são apagados automaticamente.`,
      },
      termsVersion: TERMS_VERSION,
    };
  }

  /** Inicia a contratação paga no Checkout do provedor. O estado só muda quando o webhook confirmar. */
  async checkout(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof checkoutSchema>, meta: RequestMeta) {
    const [plan] = await this.db.select().from(plans).where(and(eq(plans.key, input.planKey), eq(plans.active, true)));
    if (!plan) throw notFound('Plano');
    const priceId = input.interval === 'annual' ? plan.stripePriceAnnual : plan.stripePriceMonthly;
    if (!this.stripe.configured || !priceId) throw new AppError('validation_failed', 'A contratação paga ainda não está disponível neste ambiente (provedor ou preço não configurados).');
    const { sub } = await this.load(this.db, tenant.organizationId);
    if (sub.providerSubscriptionId && ['active', 'past_due'].includes(sub.status)) throw new AppError('conflict', 'Já existe uma assinatura paga. Use a troca de plano.');
    const usage = await usageOf(this.db, tenant.organizationId);
    if ((plan.maxUnits !== null && usage.units > plan.maxUnits) || (plan.maxUsers !== null && usage.users > plan.maxUsers)) {
      throw new AppError('plan_limit', 'O uso atual excede os limites deste plano. Escolha outro plano ou ajuste antes.', { usage, limits: { units: plan.maxUnits, users: plan.maxUsers } });
    }
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenant.organizationId));
    let customer = sub.providerCustomerId;
    if (!customer) {
      customer = (await this.stripe.createCustomer({ email: auth.email, name: org!.name, organizationId: tenant.organizationId })).id;
      await this.db.update(subscriptions).set({ providerCustomerId: customer, provider: 'stripe' }).where(eq(subscriptions.id, sub.id));
    }
    const trialEnd = sub.status === 'trial' && sub.trialEndsAt && sub.trialEndsAt > this.clock.now() ? Math.floor(sub.trialEndsAt.getTime() / 1000) : undefined;
    const session = await this.stripe.createCheckout({ customer, priceId, organizationId: tenant.organizationId, successUrl: `${env().WEB_ORIGIN}/app/assinatura?retorno=sucesso`, cancelUrl: `${env().WEB_ORIGIN}/app/assinatura?retorno=cancelado`, trialEnd });
    await this.db.transaction(async (tx) => {
      await tx.update(subscriptions).set({ pendingCheckout: true, updatedAt: this.clock.now() }).where(eq(subscriptions.id, sub.id));
      await tx.insert(termsAcceptances).values({ userId: auth.userId, organizationId: tenant.organizationId, document: 'subscription_terms', version: TERMS_VERSION, ip: meta.ip });
      await tx.insert(subscriptionChanges).values({ organizationId: tenant.organizationId, kind: 'checkout_started', toState: { plan: plan.key, interval: input.interval }, actorUserId: auth.userId, source: 'clinic' });
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'billing.checkout_started', entityType: 'subscription', entityId: sub.id, metadata: { plan: plan.key, interval: input.interval, termsVersion: TERMS_VERSION }, meta });
    });
    return { url: session.url };
  }

  /** Antes de trocar: diferenças de recursos e limites, vigência e o que precisa de adequação. */
  async previewChange(tenant: TenantContext, input: z.infer<typeof changePlanSchema>) {
    const { sub, plan } = await this.load(this.db, tenant.organizationId);
    const [next] = await this.db.select().from(plans).where(and(eq(plans.key, input.planKey), eq(plans.active, true)));
    if (!next) throw notFound('Plano');
    const usage = await usageOf(this.db, tenant.organizationId);
    const exceeding: { kind: string; usage: number; limit: number; action: string }[] = [];
    if (next.maxUnits !== null && usage.units > next.maxUnits) exceeding.push({ kind: 'units', usage: usage.units, limit: next.maxUnits, action: 'Desative unidades excedentes em Configurações (os dados ficam preservados). Nada é escolhido automaticamente.' });
    if (next.maxUsers !== null && usage.users > next.maxUsers) exceeding.push({ kind: 'users', usage: usage.users, limit: next.maxUsers, action: 'Remova membros ou cancele convites pendentes em Equipe. Ninguém é desativado automaticamente.' });
    if (usage.storageMb > next.storageMb) exceeding.push({ kind: 'storageMb', usage: usage.storageMb, limit: next.storageMb, action: 'Arquive documentos antigos ou mantenha um plano com mais armazenamento.' });
    const label = (f: string) => FEATURE_LABEL[f] ?? f;
    return {
      current: { key: plan.key, name: plan.name, interval: sub.interval, limits: { units: plan.maxUnits, users: plan.maxUsers, storageMb: plan.storageMb } },
      next: { key: next.key, name: next.name, interval: input.interval, limits: { units: next.maxUnits, users: next.maxUsers, storageMb: next.storageMb }, price: input.interval === 'annual' ? next.priceAnnual : next.priceMonthly },
      featuresGained: next.features.filter((f) => !plan.features.includes(f)).map(label),
      featuresLost: plan.features.filter((f) => !next.features.includes(f)).map(label),
      exceeding,
      effective: sub.providerSubscriptionId ? 'Imediata. O valor proporcional é calculado pelo provedor de pagamento e aparece na próxima fatura.' : 'Imediata (período de avaliação, sem cobrança).',
      dataNotice: 'Trocar de plano não apaga dados. Recursos que deixam de fazer parte do plano ficam disponíveis para leitura.',
    };
  }

  async changePlan(auth: AuthContext, tenant: TenantContext, input: z.infer<typeof changePlanSchema>, meta: RequestMeta) {
    const preview = await this.previewChange(tenant, input);
    if (preview.exceeding.length) throw new AppError('plan_limit', 'O uso atual excede os limites do novo plano. Faça a adequação antes de trocar.', { exceeding: preview.exceeding });
    const { sub, plan } = await this.load(this.db, tenant.organizationId);
    const [next] = await this.db.select().from(plans).where(eq(plans.key, input.planKey));
    if (sub.providerSubscriptionId) {
      const priceId = input.interval === 'annual' ? next!.stripePriceAnnual : next!.stripePriceMonthly;
      if (!priceId) throw new AppError('validation_failed', 'Este plano ainda não tem preço publicado para contratação.');
      const current = await this.stripe.retrieveSubscription(sub.providerSubscriptionId);
      const updated = await this.stripe.changePrice(sub.providerSubscriptionId, current.items.data[0]!.id, priceId);
      await this.db.transaction(async (tx) => this.applyStripeSubscription(tx, tenant.organizationId, updated, this.clock.now(), 'clinic', auth.userId));
    } else {
      if (sub.status !== 'trial') throw new AppError('invalid_transition', 'Para trocar de plano, conclua a contratação paga.');
      await this.db.transaction(async (tx) => {
        await tx.update(subscriptions).set({ planId: next!.id, interval: input.interval, updatedAt: this.clock.now() }).where(eq(subscriptions.id, sub.id));
        await tx.insert(subscriptionChanges).values({ organizationId: tenant.organizationId, kind: 'plan_changed', fromState: { plan: plan.key }, toState: { plan: next!.key, interval: input.interval }, actorUserId: auth.userId, source: 'clinic' });
      });
    }
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'billing.plan_changed', entityType: 'subscription', entityId: sub.id, metadata: { from: plan.key, to: input.planKey, interval: input.interval }, meta });
    return { ok: true };
  }

  /**
   * Cancelamento transparente. Com assinatura no provedor, o pedido vai ao
   * provedor primeiro; o estado local reflete a resposta confirmada.
   */
  async cancel(auth: AuthContext, tenant: TenantContext, reason: string | undefined, meta: RequestMeta) {
    const { sub, plan } = await this.load(this.db, tenant.organizationId);
    if (sub.status === 'cancelled' || sub.cancelAtPeriodEnd) throw new AppError('conflict', 'O cancelamento já foi registrado.');
    if (sub.providerSubscriptionId) {
      const updated = await this.stripe.setCancelAtPeriodEnd(sub.providerSubscriptionId, true);
      await this.db.transaction(async (tx) => this.applyStripeSubscription(tx, tenant.organizationId, updated, this.clock.now(), 'clinic', auth.userId));
    } else {
      // Sem assinatura no provedor (avaliação): não há cobrança a sincronizar.
      await this.db.transaction(async (tx) => {
        await tx.update(subscriptions).set({ status: 'cancelled', cancelledAt: this.clock.now(), readOnlyUntil: new Date(this.clock.now().getTime() + READ_ONLY_DAYS * DAY), statusReason: 'Cancelada durante a avaliação', updatedAt: this.clock.now() }).where(eq(subscriptions.id, sub.id));
        await tx.insert(subscriptionChanges).values({ organizationId: tenant.organizationId, kind: 'cancelled', fromState: { status: sub.status, plan: plan.key }, toState: { status: 'cancelled' }, actorUserId: auth.userId, source: 'clinic' });
      });
    }
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'billing.cancel_requested', entityType: 'subscription', entityId: sub.id, metadata: { reason: reason ?? null }, meta });
    return this.overview(tenant);
  }

  async resume(auth: AuthContext, tenant: TenantContext, meta: RequestMeta) {
    const { sub } = await this.load(this.db, tenant.organizationId);
    if (!sub.providerSubscriptionId || !sub.cancelAtPeriodEnd) throw new AppError('invalid_transition', 'Não há cancelamento agendado para desfazer.');
    const updated = await this.stripe.setCancelAtPeriodEnd(sub.providerSubscriptionId, false);
    await this.db.transaction(async (tx) => this.applyStripeSubscription(tx, tenant.organizationId, updated, this.clock.now(), 'clinic', auth.userId));
    await this.audit.record(this.db, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'billing.cancel_reverted', entityType: 'subscription', entityId: sub.id, meta });
    return { ok: true };
  }

  async portal(tenant: TenantContext) {
    const { sub } = await this.load(this.db, tenant.organizationId);
    if (!sub.providerCustomerId) throw new AppError('invalid_transition', 'Ainda não há dados de pagamento no provedor.');
    return this.stripe.portal(sub.providerCustomerId, `${env().WEB_ORIGIN}/app/assinatura`);
  }

  // --------------------------------------------------------------- Webhook

  /**
   * Webhook do Stripe: assinatura verificada, idempotente por event.id e
   * tolerante a eventos fora de ordem (compara event.created com o último aplicado).
   */
  async handleStripeWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = env().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new AppError('forbidden', 'Webhook não configurado.');
    if (!rawBody || !StripeClient.verifySignature(rawBody, signature, secret, this.clock.now().getTime())) throw new AppError('forbidden', 'Assinatura do webhook inválida.');
    const event = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
    const created = new Date(event.created * 1000);
    const [row] = await this.db.insert(webhookEvents).values({ provider: 'stripe', eventId: event.id, type: event.type, providerCreatedAt: created, payload: event }).onConflictDoNothing().returning({ id: webhookEvents.id });
    if (!row) return { received: true, duplicate: true };
    try {
      const status = await this.db.transaction(async (tx) => this.processEvent(tx, event, created));
      await this.db.update(webhookEvents).set({ status, processedAt: this.clock.now() }).where(eq(webhookEvents.id, row.id));
      return { received: true, status };
    } catch (err) {
      await this.db.update(webhookEvents).set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : 'erro' }).where(eq(webhookEvents.id, row.id));
      throw err;
    }
  }

  private async orgForStripe(tx: Tx, obj: Record<string, unknown>): Promise<string | null> {
    const meta = (obj.metadata ?? {}) as { organizationId?: string };
    if (meta.organizationId) return meta.organizationId;
    if (typeof obj.client_reference_id === 'string') return obj.client_reference_id;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : typeof obj.id === 'string' && String(obj.id).startsWith('sub_') ? (obj.id as string) : null;
    if (subId) {
      const [s] = await tx.select({ org: subscriptions.organizationId }).from(subscriptions).where(eq(subscriptions.providerSubscriptionId, subId));
      if (s) return s.org;
    }
    if (typeof obj.customer === 'string') {
      const [s] = await tx.select({ org: subscriptions.organizationId }).from(subscriptions).where(eq(subscriptions.providerCustomerId, obj.customer));
      if (s) return s.org;
    }
    return null;
  }

  private async processEvent(tx: Tx, event: { id: string; type: string; data: { object: Record<string, unknown> } }, created: Date): Promise<'processed' | 'ignored'> {
    const obj = event.data.object;
    const org = await this.orgForStripe(tx, obj);
    if (!org) return 'ignored';
    await tx.update(webhookEvents).set({ organizationId: org }).where(and(eq(webhookEvents.provider, 'stripe'), eq(webhookEvents.eventId, event.id)));
    switch (event.type) {
      case 'checkout.session.completed': {
        await tx.update(subscriptions).set({ providerSubscriptionId: String(obj.subscription), providerCustomerId: String(obj.customer), provider: 'stripe', pendingCheckout: false, updatedAt: this.clock.now() }).where(eq(subscriptions.organizationId, org));
        return 'processed';
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return (await this.applyStripeSubscription(tx, org, obj as unknown as StripeSubscription, created, 'webhook', null, event.type === 'customer.subscription.deleted')) ? 'processed' : 'ignored';
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        await tx
          .insert(billingInvoices)
          .values({
            organizationId: org,
            providerInvoiceId: String(obj.id),
            amount: (Number(obj.amount_paid ?? obj.amount_due ?? 0) / 100).toFixed(2),
            currency: String(obj.currency ?? 'brl').toUpperCase(),
            status: event.type === 'invoice.paid' ? 'paid' : 'open',
            hostedUrl: typeof obj.hosted_invoice_url === 'string' ? obj.hosted_invoice_url : null,
            paidAt: event.type === 'invoice.paid' ? created : null,
          })
          .onConflictDoUpdate({ target: billingInvoices.providerInvoiceId, set: { status: event.type === 'invoice.paid' ? 'paid' : 'open', paidAt: event.type === 'invoice.paid' ? created : null } });
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, org)).for('update');
        if (!sub) return 'ignored';
        if (event.type === 'invoice.payment_failed' && sub.status !== 'cancelled') {
          await tx.update(subscriptions).set({ status: 'past_due', graceUntil: sub.graceUntil ?? new Date(created.getTime() + GRACE_DAYS * DAY), statusReason: 'Falha no pagamento', updatedAt: this.clock.now() }).where(eq(subscriptions.id, sub.id));
          await tx.insert(subscriptionChanges).values({ organizationId: org, kind: 'payment_failed', fromState: { status: sub.status }, toState: { status: 'past_due' }, source: 'webhook' });
        }
        if (event.type === 'invoice.paid' && ['past_due', 'suspended'].includes(sub.status)) {
          // Regularização: volta a ativa sem criar nova assinatura nem nova cobrança.
          await tx.update(subscriptions).set({ status: 'active', graceUntil: null, readOnlyUntil: null, statusReason: null, updatedAt: this.clock.now() }).where(eq(subscriptions.id, sub.id));
          await tx.insert(subscriptionChanges).values({ organizationId: org, kind: 'regularized', fromState: { status: sub.status }, toState: { status: 'active' }, source: 'webhook' });
        }
        return 'processed';
      }
      default:
        return 'ignored';
    }
  }

  /** Aplica o estado da assinatura informado pelo provedor, se for mais novo que o último aplicado. */
  async applyStripeSubscription(tx: Tx, org: string, s: StripeSubscription, eventAt: Date, source: 'webhook' | 'clinic', actorUserId: string | null, deleted = false): Promise<boolean> {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, org)).for('update');
    if (!sub) return false;
    if (source === 'webhook' && sub.lastEventAt && eventAt < sub.lastEventAt) return false;
    const priceId = s.items?.data?.[0]?.price?.id;
    const [plan] = priceId ? await tx.select().from(plans).where(sql`${plans.stripePriceMonthly} = ${priceId} or ${plans.stripePriceAnnual} = ${priceId}`) : [];
    const map: Record<string, 'trial' | 'active' | 'past_due' | 'cancelled'> = { trialing: 'trial', active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'cancelled', incomplete_expired: 'cancelled' };
    const status = deleted ? 'cancelled' : map[s.status];
    if (!status) return false; // "incomplete": pagamento ainda não confirmado — nada muda.
    const periodEnd = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
    const values = {
      status,
      providerSubscriptionId: s.id,
      providerCustomerId: typeof s.customer === 'string' ? s.customer : sub.providerCustomerId,
      provider: 'stripe',
      planId: plan?.id ?? sub.planId,
      interval: plan && priceId === plan.stripePriceAnnual ? 'annual' : plan ? 'monthly' : sub.interval,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : sub.currentPeriodEnd,
      trialEndsAt: s.trial_end ? new Date(s.trial_end * 1000) : sub.trialEndsAt,
      graceUntil: status === 'past_due' ? (sub.graceUntil ?? new Date(eventAt.getTime() + GRACE_DAYS * DAY)) : null,
      cancelledAt: status === 'cancelled' ? (sub.cancelledAt ?? eventAt) : null,
      readOnlyUntil: status === 'cancelled' ? new Date(eventAt.getTime() + READ_ONLY_DAYS * DAY) : null,
      pendingCheckout: false,
      lastEventAt: source === 'webhook' ? eventAt : sub.lastEventAt,
      updatedAt: this.clock.now(),
    } as const;
    await tx.update(subscriptions).set(values).where(eq(subscriptions.id, sub.id));
    if (sub.status !== status || sub.planId !== values.planId || sub.cancelAtPeriodEnd !== values.cancelAtPeriodEnd) {
      await tx.insert(subscriptionChanges).values({ organizationId: org, kind: 'provider_update', fromState: { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd }, toState: { status, cancelAtPeriodEnd: values.cancelAtPeriodEnd, plan: plan?.key ?? null }, actorUserId, source });
    }
    return true;
  }

  /** Tarefa diária: fim de avaliação e fim de carência viram somente-leitura (nunca exclusão). */
  async evaluate() {
    const now = this.clock.now();
    const due = await this.db
      .select()
      .from(subscriptions)
      .where(sql`(${subscriptions.status} = 'trial' and ${subscriptions.trialEndsAt} <= ${now} and ${subscriptions.providerSubscriptionId} is null) or (${subscriptions.status} = 'past_due' and ${subscriptions.graceUntil} <= ${now})`);
    for (const s of due) {
      const reason = s.status === 'trial' ? 'Período de avaliação encerrado' : 'Pagamento não regularizado após a carência';
      await this.db.transaction(async (tx) => {
        await tx.update(subscriptions).set({ status: 'suspended', statusReason: reason, readOnlyUntil: new Date(now.getTime() + READ_ONLY_DAYS * DAY), updatedAt: now }).where(and(eq(subscriptions.id, s.id), ne(subscriptions.status, 'suspended')));
        await tx.insert(subscriptionChanges).values({ organizationId: s.organizationId, kind: 'suspended', fromState: { status: s.status }, toState: { status: 'suspended', reason }, source: 'system' });
      });
    }
    return due.length;
  }

  async webhookFailures() {
    return this.db.select().from(webhookEvents).where(inArray(webhookEvents.status, ['failed'])).orderBy(desc(webhookEvents.receivedAt)).limit(100);
  }

}
