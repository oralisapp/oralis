import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { createTransport, type Transporter } from 'nodemailer';
import { Clock } from '../../common/clock';
import { env } from '../../config/env';
import { DB, type Db } from '../../db/db';
import { emailMessages } from '../../db/schema';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  organizationId?: string | null;
  category?: 'transactional' | 'relationship' | 'promotional';
}

export type MailDelivery = 'sent' | 'queued_retry' | 'logged_locally';

const MAX_ATTEMPTS = 5;

/**
 * Envio de e-mail com registro de cada mensagem.
 * - Com SMTP_URL: envia; em falha agenda nova tentativa com espera crescente.
 * - Sem SMTP_URL (só fora de produção): grava na caixa de saída local e não envia.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transport: Transporter | null | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get configured(): boolean {
    return !!env().SMTP_URL;
  }

  private getTransport(): Transporter | null {
    if (this.transport === undefined) this.transport = env().SMTP_URL ? createTransport(env().SMTP_URL) : null;
    return this.transport;
  }

  async send(input: MailInput): Promise<{ id: string; delivery: MailDelivery }> {
    const [msg] = await this.db
      .insert(emailMessages)
      .values({
        organizationId: input.organizationId ?? null,
        toAddress: input.to,
        subject: input.subject,
        bodyText: input.text,
        bodyHtml: input.html ?? null,
        category: input.category ?? 'transactional',
        status: this.configured ? 'pending' : 'logged',
        nextAttemptAt: this.configured ? this.clock.now() : null,
      })
      .returning({ id: emailMessages.id });
    if (!this.configured) {
      this.logger.log(`Caixa de saída local (SMTP não configurado): "${input.subject}" para ${input.to}`);
      return { id: msg!.id, delivery: 'logged_locally' };
    }
    const ok = await this.attempt(msg!.id);
    return { id: msg!.id, delivery: ok ? 'sent' : 'queued_retry' };
  }

  /**
   * O lock da linha cobre o envio e a persistência: workers concorrentes pulam
   * a mensagem já reservada. Uma queda após aceitação SMTP e antes do commit
   * ainda pode repetir a entrega; SMTP não oferece garantia exactly-once.
   */
  private async attempt(id: string): Promise<boolean> {
    const transport = this.getTransport();
    if (!transport) return false;
    return this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(emailMessages)
        .where(and(eq(emailMessages.id, id), eq(emailMessages.status, 'pending'), lt(emailMessages.attempts, MAX_ATTEMPTS),
          or(isNull(emailMessages.nextAttemptAt), lte(emailMessages.nextAttemptAt, this.clock.now()))))
        .for('update', { skipLocked: true });
      if (!m) return false;
      let info: { messageId?: string };
      try {
        // Identificador estável facilita rastrear eventual repetição após falha.
        info = await transport.sendMail({ messageId: '<' + m.id + '@mail.oralis.local>', from: env().MAIL_FROM, to: m.toAddress, subject: m.subject, text: m.bodyText ?? '', html: m.bodyHtml ?? undefined });
      } catch (err) {
        const attempts = m.attempts + 1;
        await tx.update(emailMessages).set({
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts,
          lastError: err instanceof Error ? err.message.slice(0, 500) : 'erro desconhecido',
          nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(this.clock.now().getTime() + 2 ** attempts * 60_000),
        }).where(eq(emailMessages.id, id));
        this.logger.warn('Falha ao enviar e-mail ' + id + ' (tentativa ' + attempts + ').');
        return false;
      }
      // Falha de persistência não é tratada como recusa SMTP.
      await tx.update(emailMessages).set({ status: 'sent', sentAt: this.clock.now(), attempts: m.attempts + 1,
        providerMessageId: info.messageId ?? null, bodyText: null, bodyHtml: null, lastError: null, nextAttemptAt: null })
        .where(eq(emailMessages.id, id));
      return true;
    });
  }

  /** Reenvia mensagens pendentes cujo horário de nova tentativa chegou. */
  async retryDue(): Promise<number> {
    if (!this.configured) return 0;
    const due = await this.db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.status, 'pending'), lt(emailMessages.attempts, MAX_ATTEMPTS), or(isNull(emailMessages.nextAttemptAt), lte(emailMessages.nextAttemptAt, this.clock.now()))))
      .limit(50);
    for (const d of due) await this.attempt(d.id);
    return due.length;
  }

  /** Caixa de saída local para desenvolvimento. */
  async outbox(limit = 50) {
    return this.db
      .select()
      .from(emailMessages)
      .where(inArray(emailMessages.status, ['logged']))
      .orderBy(emailMessages.createdAt)
      .limit(limit);
  }
}

/** Layout HTML mínimo e acessível para os e-mails transacionais. */
export function mailLayout(title: string, paragraphs: string[], action?: { label: string; url: string }): { text: string; html: string } {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const text = [title, '', ...paragraphs, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', '— Oralis Cloud'].join('\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#102a30;background:#f5f8f8;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #d6e0e0">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5">${esc(p)}</p>`).join('')}
${action ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="background:#0c5c6c;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(action.label)}</a></p><p style="font-size:12px;color:#4f656a">Se o botão não funcionar, copie: ${esc(action.url)}</p>` : ''}
<p style="font-size:12px;color:#4f656a;margin-top:24px">Oralis Cloud</p></div></body></html>`;
  return { text, html };
}
