import { and, eq } from 'drizzle-orm';
import { auditEvents } from '../src/db/schema';
import { type Clinic, type TestContext, createClinic, createTestApp, resetDb } from './helpers';

describe('Pacientes', () => {
  let t: TestContext;
  let c: Clinic;
  const url = () => `/orgs/${c.orgId}/patients`;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'pacientes@exemplo.test');
  });
  afterAll(() => t.close());

  it('cadastra com CPF e telefone normalizados', async () => {
    const r = await c.owner.post(url(), { fullName: 'João da Silva', cpf: '529.982.247-25', phone: '(11) 98765-4321', birthDate: '1990-05-20' });
    expect(r.status).toBe(201);
    const d = await c.owner.get(`${url()}/${r.body.id}`);
    expect(d.body.patient).toMatchObject({ cpf: '52998224725', phone: '11987654321', birthDate: '1990-05-20', version: 1 });
  });

  it('bloqueia CPF duplicado na mesma organização', async () => {
    const r = await c.owner.post(url(), { fullName: 'Outro Nome', cpf: '52998224725' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'duplicate_patient', details: { blocking: true } });
  });

  it('pede confirmação para mesmo nome + nascimento e aceita quando confirmado', async () => {
    const first = await c.owner.post(url(), { fullName: 'JOAO DA SILVA', birthDate: '1990-05-20' });
    expect(first.status).toBe(409);
    expect(first.body.error.details.blocking).toBe(false);
    expect(first.body.error.details.candidates).toHaveLength(1);
    const forced = await c.owner.post(`${url()}?allowPossibleDuplicate=true`, { fullName: 'JOAO DA SILVA', birthDate: '1990-05-20' });
    expect(forced.status).toBe(201);
  });

  it('busca ignora acentos e maiúsculas e encontra por telefone', async () => {
    const byName = await c.owner.get(`${url()}?q=joão`);
    expect(byName.body.total).toBe(2);
    const byPhone = await c.owner.get(`${url()}?q=98765`);
    expect(byPhone.body.items.map((p: { fullName: string }) => p.fullName)).toEqual(['João da Silva']);
  });

  it('recusa CPF com dígito verificador inválido', async () => {
    const r = await c.owner.post(url(), { fullName: 'Fulano Teste', cpf: '123.456.789-00' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('CPF inválido.');
  });

  it('edição exige a versão atual e audita apenas os nomes dos campos alterados', async () => {
    const created = await c.owner.post(url(), { fullName: 'Maria Souza', email: 'maria@exemplo.test' });
    const id = created.body.id;
    const ok = await c.owner.put(`${url()}/${id}`, { fullName: 'Maria Souza', email: 'maria.souza@exemplo.test', version: 1 });
    expect(ok.status).toBe(200);
    const stale = await c.owner.put(`${url()}/${id}`, { fullName: 'Maria S.', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_version');

    const [ev] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, 'patient.updated')));
    expect(ev!.metadata).toEqual({ fields: ['email'] });
    expect(JSON.stringify(ev!.metadata)).not.toContain('maria');
  });

  it('acesso à ficha é auditado', async () => {
    const created = await c.owner.post(url(), { fullName: 'Pedro Lima' });
    await c.owner.get(`${url()}/${created.body.id}`);
    const views = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, 'patient.viewed')));
    expect(views).toHaveLength(1);
  });
});
