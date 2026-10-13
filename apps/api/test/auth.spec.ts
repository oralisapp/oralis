import { CSRF_HEADER } from '@oralis/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { auditEvents, sessions, users } from '../src/db/schema';
import { Client, PASSWORD, type TestContext, createTestApp, resetDb, signup } from './helpers';

describe('Identidade e sessões', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  it('cadastro cria sessão, guarda senha com argon2id e não expõe o hash', async () => {
    const c = await signup(t.app, 'ana@exemplo.test', 'Ana');
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ id: expect.any(String), name: 'Ana', email: 'ana@exemplo.test', mfaEnabled: false });
    expect(JSON.stringify(me.body)).not.toContain('argon2');
    const [u] = await t.db.select().from(users).where(eq(users.email, 'ana@exemplo.test'));
    expect(u!.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('e-mail é normalizado e não pode ser cadastrado duas vezes', async () => {
    const c = new Client(t.app);
    const r = await c.post('/auth/signup', { name: 'Outra', email: '  ANA@Exemplo.test ', password: PASSWORD });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
  });

  it('valida senha curta com mensagem em português', async () => {
    const r = await new Client(t.app).post('/auth/signup', { name: 'Bia', email: 'bia@exemplo.test', password: '123' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.message).toMatch(/10 caracteres/);
  });

  it('login com senha errada falha e é auditado sem revelar se o e-mail existe', async () => {
    const wrong = await new Client(t.app).post('/auth/login', { email: 'ana@exemplo.test', password: 'errada-errada' });
    const unknown = await new Client(t.app).post('/auth/login', { email: 'ninguem@exemplo.test', password: 'errada-errada' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const failed = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login_failed'));
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });

  it('logout revoga a sessão no servidor: o cookie antigo deixa de funcionar', async () => {
    const c = new Client(t.app);
    const login = await c.post('/auth/login', { email: 'ana@exemplo.test', password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    expect((await c.post('/auth/logout')).status).toBe(200);
    const reuse = await request(t.app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie);
    expect(reuse.status).toBe(401);
  });

  it('usuário lista e revoga outra sessão sua', async () => {
    const a = new Client(t.app);
    const b = new Client(t.app);
    await a.post('/auth/login', { email: 'ana@exemplo.test', password: PASSWORD });
    await b.post('/auth/login', { email: 'ana@exemplo.test', password: PASSWORD });
    const list = await a.get('/auth/sessions');
    const other = (list.body as { id: string; current: boolean }[]).find((s) => !s.current)!;
    expect((await a.delete(`/auth/sessions/${other.id}`)).status).toBe(200);
    const stillValid = await Promise.all([a.get('/auth/me'), b.get('/auth/me')]);
    expect(stillValid.map((r) => r.status).sort()).toEqual([200, 401]);
    const revoked = await t.db.select().from(sessions).where(eq(sessions.id, other.id));
    expect(revoked[0]!.revokedAt).not.toBeNull();
  });

  it('rotas protegidas exigem sessão', async () => {
    const r = await request(t.app.getHttpServer()).get('/api/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });

  it('mutação sem cabeçalho CSRF ou de outra origem é recusada', async () => {
    const server = t.app.getHttpServer();
    const noHeader = await request(server).post('/api/auth/login').send({ email: 'ana@exemplo.test', password: PASSWORD });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('csrf_rejected');
    const evil = await request(server)
      .post('/api/auth/login')
      .set(CSRF_HEADER, '1')
      .set('Origin', 'https://site-malicioso.example')
      .send({ email: 'ana@exemplo.test', password: PASSWORD });
    expect(evil.status).toBe(403);
  });

  it('limita tentativas de login por IP + e-mail', async () => {
    const c = new Client(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await c.post('/auth/login', { email: 'alvo@exemplo.test', password: 'x' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
