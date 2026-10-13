import { MobileMessageProvider } from '../src/modules/engagement/mobile-message-provider';

const config = {
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'test-secret',
  TWILIO_SMS_FROM: '+14155550100', TWILIO_WHATSAPP_FROM: '+14155550101',
  TWILIO_TIMEOUT_MS: 1000,
  TWILIO_WHATSAPP_TEMPLATES: { 'template-version': { contentSid: `HX${'b'.repeat(32)}`, variables: { '1': 'primeiro_nome' as const } } },
};

describe('MobileMessageProvider', () => {
  const request = jest.fn();
  beforeEach(() => request.mockReset());
  const provider = (overrides = {}) => new MobileMessageProvider({ ...config, ...overrides }, request);

  it('posts SMS once with Basic authentication and E.164 numbers; acceptance is queued', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ sid: `SM${'c'.repeat(32)}`, status: 'queued' }), { status: 201 }));
    const result = await provider().send({ channel: 'sms', phone: '+55 (92) 99999-1234', body: 'Confirme sua consulta' });
    expect(result).toMatchObject({ status: 'queued', providerMessageId: `SM${'c'.repeat(32)}` });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:test-secret`).toString('base64')}`);
    expect(init.body.get('To')).toBe('+5592999991234');
    expect(init.body.get('Body')).toBe('Confirme sua consulta');
  });

  it('uses approved WhatsApp content and substitutes named variables without a freeform Body', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ sid: `SM${'c'.repeat(32)}`, status: 'accepted' }), { status: 201 }));
    await provider().send({ channel: 'whatsapp', phone: '+5592999991234', body: 'Olá Ana', templateId: 'template-version', vars: { primeiro_nome: 'Ana' } });
    const init = request.mock.calls[0]![1];
    expect(init.body.get('To')).toBe('whatsapp:+5592999991234');
    expect(init.body.get('ContentSid')).toBe(config.TWILIO_WHATSAPP_TEMPLATES['template-version'].contentSid);
    expect(JSON.parse(init.body.get('ContentVariables'))).toEqual({ '1': 'Ana' });
    expect(init.body.has('Body')).toBe(false);
  });

  it('does not contact the provider with missing credentials, template, or ambiguous local phone', async () => {
    expect((await provider({ TWILIO_AUTH_TOKEN: undefined }).send({ channel: 'sms', phone: '+5592999991234', body: 'x' })).status).toBe('not_configured');
    expect((await provider().send({ channel: 'whatsapp', phone: '+5592999991234', body: 'x' })).status).toBe('not_configured');
    expect((await provider().send({ channel: 'sms', phone: '9999', body: 'x' })).status).toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a missing approved variable before sending', async () => {
    expect((await provider().send({ channel: 'whatsapp', phone: '+5592999991234', body: 'x', templateId: 'template-version' })).status).toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('converts the Brazilian national phone stored by patient registration to E.164', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ sid: `SM${'c'.repeat(32)}` }), { status: 201 }));
    await provider().send({ channel: 'sms', phone: '92999991234', body: 'x' });
    expect(request.mock.calls[0]![1].body.get('To')).toBe('+5592999991234');
  });

  it('does not turn malformed successful responses or server errors into confirmed sends', async () => {
    request.mockResolvedValueOnce(new Response('invalid', { status: 201 }));
    request.mockResolvedValueOnce(new Response('secret', { status: 503 }));
    for (let i = 0; i < 2; i++) {
      const result = await provider().send({ channel: 'sms', phone: '92999991234', body: 'x' });
      expect(result.status).toBe('queued');
      expect(result.detail).toContain('incerto');
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('sanitizes provider rejection and never retries a POST', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ message: 'private phone test-secret', code: 21610 }), { status: 400 }));
    const result = await provider().send({ channel: 'sms', phone: '+5592999991234', body: 'x' });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toMatch(/private|test-secret/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports timeout/unknown acceptance without retrying or claiming delivery', async () => {
    request.mockRejectedValue(new Error('timeout test-secret'));
    const result = await provider().send({ channel: 'sms', phone: '+5592999991234', body: 'x' });
    expect(result.status).toBe('queued');
    expect(result.detail).toContain('incerto');
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('aborts an unresponsive provider after the configured deadline', async () => {
    request.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    const result = await provider({ TWILIO_TIMEOUT_MS: 20 }).send({ channel: 'sms', phone: '92999991234', body: 'x' });
    expect(result.status).toBe('queued');
    expect(result.detail).toContain('incerto');
    expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
