import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { safeEqual } from '../../common/crypto';
import { AppError } from '../../common/app-error';
import { env } from '../../config/env';

/** Codifica objetos aninhados no formato application/x-www-form-urlencoded da API do Stripe. */
function form(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? out.push(...form(item as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === 'object') out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

/**
 * Cliente mínimo da API REST do Stripe (sem SDK). Só funciona com
 * STRIPE_SECRET_KEY configurada; sem ela, toda chamada falha com mensagem clara.
 * Cartões nunca passam pelo Oralis: o pagamento acontece no Checkout do provedor.
 */
@Injectable()
export class StripeClient {
  get configured(): boolean {
    return !!env().STRIPE_SECRET_KEY;
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const key = env().STRIPE_SECRET_KEY;
    if (!key) throw new AppError('validation_failed', 'O provedor de pagamento não está configurado neste ambiente.');
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? form(body).join('&') : undefined,
    });
    const data = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new AppError('validation_failed', `Provedor de pagamento recusou a operação: ${data.error?.message ?? res.status}`);
    return data;
  }

  createCustomer(input: { email: string; name: string; organizationId: string }) {
    return this.call<{ id: string }>('POST', '/customers', { email: input.email, name: input.name, metadata: { organizationId: input.organizationId } }, `customer-${input.organizationId}`);
  }

  createCheckout(input: { customer: string; priceId: string; organizationId: string; successUrl: string; cancelUrl: string; trialEnd?: number }) {
    return this.call<{ id: string; url: string }>('POST', '/checkout/sessions', {
      mode: 'subscription',
      customer: input.customer,
      client_reference_id: input.organizationId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      locale: 'pt-BR',
      subscription_data: { metadata: { organizationId: input.organizationId }, ...(input.trialEnd ? { trial_end: input.trialEnd } : {}) },
      metadata: { organizationId: input.organizationId },
    });
  }

  retrieveSubscription(id: string) {
    return this.call<StripeSubscription>('GET', `/subscriptions/${id}`);
  }

  changePrice(subscriptionId: string, itemId: string, priceId: string) {
    return this.call<StripeSubscription>('POST', `/subscriptions/${subscriptionId}`, { items: [{ id: itemId, price: priceId }], proration_behavior: 'create_prorations' });
  }

  setCancelAtPeriodEnd(subscriptionId: string, value: boolean) {
    return this.call<StripeSubscription>('POST', `/subscriptions/${subscriptionId}`, { cancel_at_period_end: value });
  }

  portal(customer: string, returnUrl: string) {
    return this.call<{ url: string }>('POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
  }

  /**
   * Verifica o cabeçalho Stripe-Signature (t=…,v1=…) com HMAC-SHA256 sobre
   * "t.corpo_bruto", com tolerância de 5 minutos contra repetição.
   */
  static verifySignature(rawBody: Buffer, header: string | undefined, secret: string, nowMs = Date.now()): boolean {
    if (!header) return false;
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2));
    const t = Number(parts.t);
    if (!t || Math.abs(nowMs / 1000 - t) > 300) return false;
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
    const signatures = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    return signatures.some((s) => safeEqual(s, expected));
  }

  static sign(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
  }
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
  cancel_at_period_end: boolean;
  current_period_end?: number;
  trial_end?: number | null;
  metadata?: { organizationId?: string };
  items: { data: { id: string; price: { id: string; recurring?: { interval: 'month' | 'year' } }; current_period_end?: number }[] };
}
