import { desc, eq } from 'drizzle-orm';
import { base32Decode, hotp, totpStep } from '../src/common/crypto';
import { emailMessages, userMfa } from '../src/db/schema';
import { Client, PASSWORD, type TestContext, addMember, createClinic, createTestApp, resetDb, signup } from './helpers';

describe('Segurança da conta: senha, MFA e e-mails', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const lastEmailTo = async (to: string) => {
    const [m] = await t.db.select().from(emailMessages).where(eq(emailMessages.toAddress, to)).orderBy(desc(emailMessages.createdAt)).limit(1);
    return m;
  };
  const tokenFrom = (text: string | null | undefined) => /token=([A-Za-z0-9_-]+)/.exec(text ?? '')?.[1] ?? '';

  describe('redefinição de senha', () => {
    it('responde igual para e-mail existente e inexistente', async () => {
      await signup(t.app, 'reset@exemplo.test');
      const a = await new Client(t.app).post('/auth/password/forgot', { email: 'reset@exemplo.test' });
      const b = await new Client(t.app).post('/auth/password/forgot', { email: 'ninguem@exemplo.test' });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body).toEqual(b.body);
      expect(await lastEmailTo('ninguem@exemplo.test')).toBeUndefined();
      const mail = await lastEmailTo('reset@exemplo.test');
      expect(mail!.status).toBe('logged'); // SMTP não configurado nos testes: caixa de saída local
    });

    it('troca a senha, encerra sessões abertas e o link não pode ser reutilizado', async () => {
      const old = new Client(t.app);
      await old.post('/auth/login', { email: 'reset@exemplo.test', password: PASSWORD });
      const token = tokenFrom((await lastEmailTo('reset@exemplo.test'))!.bodyText);
      expect(token).not.toBe('');

      const r = await new Client(t.app).post('/auth/password/reset', { token, password: 'nova-senha-segura-1' });
      expect(r.status).toBe(200);
      expect((await old.get('/auth/me')).status).toBe(401);
      expect((await new Client(t.app).post('/auth/password/reset', { token, password: 'outra-senha-segura' })).status).toBe(422);
      expect((await new Client(t.app).post('/auth/login', { email: 'reset@exemplo.test', password: PASSWORD })).status).toBe(401);
      expect((await new Client(t.app).post('/auth/login', { email: 'reset@exemplo.test', password: 'nova-senha-segura-1' })).status).toBe(200);
    });

    it('link expira em 1 hora', async () => {
      await new Client(t.app).post('/auth/password/forgot', { email: 'reset@exemplo.test' });
      const token = tokenFrom((await lastEmailTo('reset@exemplo.test'))!.bodyText);
      t.clock.set(new Date(t.clock.now().getTime() + 61 * 60_000).toISOString());
      expect((await new Client(t.app).post('/auth/password/reset', { token, password: 'senha-depois-de-expirar' })).status).toBe(422);
      t.clock.set('2030-03-12T13:00:00.000Z');
    });
  });

  it('troca de senha exige a senha atual e encerra as outras sessões', async () => {
    const a = await signup(t.app, 'troca@exemplo.test');
    const b = new Client(t.app);
    await b.post('/auth/login', { email: 'troca@exemplo.test', password: PASSWORD });
    expect((await a.post('/auth/password/change', { currentPassword: 'errada', newPassword: 'nova-senha-123456' })).status).toBe(422);
    expect((await a.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'nova-senha-123456' })).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(200);
    expect((await b.get('/auth/me')).status).toBe(401);
  });

  describe('verificação em duas etapas (TOTP)', () => {
    let client: Client;
    let secret = '';
    let recovery: string[] = [];
    const code = (offsetSteps = 0) => hotp(base32Decode(secret), totpStep(t.clock.now()) + offsetSteps);

    beforeAll(async () => {
      client = await signup(t.app, 'mfa@exemplo.test');
    });

    it('cadastro guarda o segredo cifrado e só ativa com código válido', async () => {
      const setup = await client.post('/auth/mfa/setup');
      expect(setup.status).toBe(201);
      expect(setup.body.qrSvg).toContain('<svg');
      secret = setup.body.secret;
      const [row] = await t.db.select().from(userMfa);
      expect(row!.secretEncrypted).not.toContain(secret);
      expect((await client.post('/auth/mfa/enable', { code: '000000' })).status).toBe(422);
      const ok = await client.post('/auth/mfa/enable', { code: code() });
      expect(ok.status).toBe(201);
      expect(ok.body.recoveryCodes).toHaveLength(10);
      recovery = ok.body.recoveryCodes;
    });

    it('login passa a exigir o código e não reaproveita o mesmo código', async () => {
      const c = new Client(t.app);
      const first = await c.post('/auth/login', { email: 'mfa@exemplo.test', password: PASSWORD });
      expect(first.body).toMatchObject({ mfaRequired: true });
      expect((await c.get('/auth/me')).status).toBe(401);
      // O código usado na ativação não pode ser reutilizado.
      expect((await c.post('/auth/login/mfa', { challengeToken: first.body.challengeToken, code: code() })).status).toBe(401);
      t.clock.set(new Date(t.clock.now().getTime() + 30_000).toISOString());
      expect((await c.post('/auth/login/mfa', { challengeToken: first.body.challengeToken, code: code() })).status).toBe(200);
      expect((await c.get('/auth/me')).body.user.mfaEnabled).toBe(true);
    });

    it('código de recuperação funciona uma única vez', async () => {
      const rc = recovery[0]!;
      const c1 = new Client(t.app);
      const l1 = await c1.post('/auth/login', { email: 'mfa@exemplo.test', password: PASSWORD });
      expect((await c1.post('/auth/login/mfa', { challengeToken: l1.body.challengeToken, code: rc })).status).toBe(200);
      const c2 = new Client(t.app);
      const l2 = await c2.post('/auth/login', { email: 'mfa@exemplo.test', password: PASSWORD });
      expect((await c2.post('/auth/login/mfa', { challengeToken: l2.body.challengeToken, code: rc })).status).toBe(401);
    });

    it('desafio bloqueia após 5 códigos errados', async () => {
      const c = new Client(t.app);
      const l = await c.post('/auth/login', { email: 'mfa@exemplo.test', password: PASSWORD });
      for (let i = 0; i < 5; i++) await c.post('/auth/login/mfa', { challengeToken: l.body.challengeToken, code: '123456' });
      t.clock.set(new Date(t.clock.now().getTime() + 30_000).toISOString());
      expect((await c.post('/auth/login/mfa', { challengeToken: l.body.challengeToken, code: code() })).status).toBe(401);
    });
  });

  it('clínica pode exigir MFA de proprietários e gestores', async () => {
    const clinic = await createClinic(t.app, 'dona-mfa@exemplo.test');
    const denied = await clinic.owner.put(`/orgs/${clinic.orgId}/security`, { requireMfaPrivileged: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('mfa_required');

    const setup = await clinic.owner.post('/auth/mfa/setup');
    const s = setup.body.secret as string;
    t.clock.set(new Date(t.clock.now().getTime() + 60_000).toISOString());
    await clinic.owner.post('/auth/mfa/enable', { code: hotp(base32Decode(s), totpStep(t.clock.now())) });
    expect((await clinic.owner.put(`/orgs/${clinic.orgId}/security`, { requireMfaPrivileged: true })).status).toBe(200);

    // Um gestor sem MFA perde o acesso até ativar.
    const manager = await addMember(t.app, clinic, 'gestor-mfa@exemplo.test', 'manager');
    const r = await manager.client.get(`/orgs/${clinic.orgId}/patients`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('mfa_required');
    const me = await manager.client.get('/auth/me');
    expect(me.body.memberships[0].mfaRequired).toBe(true);
    // Recepção não é afetada pela política.
    const reception = await addMember(t.app, clinic, 'recep-mfa@exemplo.test', 'reception');
    expect((await reception.client.get(`/orgs/${clinic.orgId}/patients`)).status).toBe(200);
  });
});
