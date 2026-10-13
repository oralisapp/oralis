import { normalizeBrPhone } from '@oralis/shared';
import { type AppEnv } from '../../config/env';

type Config = Pick<AppEnv, 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_SMS_FROM' | 'TWILIO_WHATSAPP_FROM' | 'TWILIO_WHATSAPP_TEMPLATES' | 'TWILIO_TIMEOUT_MS'>;
type Input = { channel: 'sms' | 'whatsapp'; phone: string | null; body: string; templateId?: string | null; vars?: Record<string, string> };
type Result = { status: 'queued' | 'failed' | 'not_configured'; detail: string; providerMessageId?: string };

/** Sends once: a lost response is never automatically retried. */
export class MobileMessageProvider {
  constructor(private readonly config: Config, private readonly request: typeof fetch = fetch) {}

  configured(channel: string, templateId?: string | null): boolean {
    const c = this.config;
    return Boolean(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && (channel === 'sms'
      ? c.TWILIO_SMS_FROM
      : channel === 'whatsapp' && c.TWILIO_WHATSAPP_FROM && templateId && c.TWILIO_WHATSAPP_TEMPLATES[templateId]));
  }

  async send(input: Input): Promise<Result> {
    if (!this.configured(input.channel, input.templateId)) return { status: 'not_configured', detail: 'Provedor ou modelo aprovado não configurado para este canal. Nenhuma mensagem enviada.' };
    const phone = input.phone?.trim() ?? '';
    const compact = phone.replace(/[\s().-]/g, '');
    // Patient phone numbers are stored in Brazilian national format by the shared schema.
    const national = !compact.startsWith('+') && /^[0-9]+$/.test(compact) ? normalizeBrPhone(compact) : null;
    const to = national ? `+55${national}` : compact;
    if (!/^\+[1-9][0-9]{7,14}$/.test(to)) return { status: 'failed', detail: 'Paciente sem telefone válido com DDD ou código internacional.' };
    const c = this.config;
    const prefix = input.channel === 'whatsapp' ? 'whatsapp:' : '';
    const body = new URLSearchParams({ From: `${prefix}${input.channel === 'sms' ? c.TWILIO_SMS_FROM : c.TWILIO_WHATSAPP_FROM}`, To: `${prefix}${to}` });
    if (input.channel === 'whatsapp') {
      const template = c.TWILIO_WHATSAPP_TEMPLATES[input.templateId!]!;
      const variables: Record<string, string> = {};
      for (const [key, name] of Object.entries(template.variables)) {
        const value = input.vars?.[name];
        if (!value?.trim()) return { status: 'failed', detail: 'Variável obrigatória ausente no modelo aprovado do WhatsApp.' };
        variables[key] = value;
      }
      body.set('ContentSid', template.contentSid);
      body.set('ContentVariables', JSON.stringify(variables));
    } else body.set('Body', input.body);
    const uncertain: Result = { status: 'queued', detail: 'Resultado incerto no provedor. Confira o console Twilio antes de reenviar; não houve repetição automática.' };
    try {
      const response = await this.request(`https://api.twilio.com/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(c.TWILIO_TIMEOUT_MS),
        headers: { Authorization: `Basic ${Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      if (response.status >= 500) return uncertain;
      if (!response.ok) return { status: 'failed', detail: `Provedor rejeitou o envio (HTTP ${response.status}). Verifique a configuração e o console Twilio.` };
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('sid' in result) || typeof result.sid !== 'string' || !/^SM[0-9a-f]{32}$/i.test(result.sid)) return uncertain;
      const status = 'status' in result ? result.status : undefined;
      if (status === 'failed' || status === 'undelivered' || status === 'canceled') return { status: 'failed', providerMessageId: result.sid, detail: 'Provedor informou falha no envio. Consulte o console Twilio.' };
      return { status: 'queued', providerMessageId: result.sid, detail: 'Mensagem aceita pelo provedor; entrega e leitura ainda não confirmadas.' };
    } catch {
      return uncertain;
    }
  }
}
