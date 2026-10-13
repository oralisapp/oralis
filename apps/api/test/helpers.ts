import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER } from '@oralis/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { Clock } from '../src/common/clock';
import { overrideEnvForTests } from '../src/config/env';
import { DB, type Db } from '../src/db/db';

/** Terça-feira, 12/03/2030, 10:00 em São Paulo (13:00 UTC). */
export const FIXED_NOW = new Date('2030-03-12T13:00:00.000Z');
export const TODAY = '2030-03-12';
export const TZ = 'America/Sao_Paulo';

export class FakeClock extends Clock {
  current = new Date(FIXED_NOW);
  override now(): Date {
    return new Date(this.current);
  }
  set(iso: string) {
    this.current = new Date(iso);
  }
}

export interface TestContext {
  app: INestApplication;
  db: Db;
  clock: FakeClock;
  close: () => Promise<void>;
}

export async function createTestApp(extraEnv: Record<string, string> = {}): Promise<TestContext> {
  overrideEnvForTests({ APP_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL_TEST!, STORAGE_DIR: '.data/test-uploads', SMTP_URL: undefined, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_SMS_FROM: undefined, TWILIO_WHATSAPP_FROM: undefined, TWILIO_WHATSAPP_TEMPLATES: {}, ...extraEnv });
  const clock = new FakeClock();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, rawBody: true, logger: false });
  configureApp(app);
  await app.init();
  const db = app.get<Db>(DB);
  return { app, db, clock, close: () => app.close() };
}

/** Limpa todas as tabelas (TRUNCATE não dispara os gatilhos de somente-inserção). */
export async function resetDb(db: Db): Promise<void> {
  const r = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  // O catálogo de planos é dado de referência (semeado pela migração): não é apagado.
  const names = r.rows.filter((t) => t.tablename !== 'plans').map((t) => `"${t.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}

/** Cliente HTTP com cookie de sessão persistente e cabeçalho CSRF nas mutações. */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;

  constructor(app: INestApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  get(url: string) {
    return this.agent.get(`/api${url}`);
  }
  post(url: string, body: object = {}) {
    return this.agent.post(`/api${url}`).set(CSRF_HEADER, '1').send(body);
  }
  put(url: string, body: object = {}) {
    return this.agent.put(`/api${url}`).set(CSRF_HEADER, '1').send(body);
  }
  delete(url: string) {
    return this.agent.delete(`/api${url}`).set(CSRF_HEADER, '1');
  }
}

export const PASSWORD = 'senha-de-teste-123';

export async function signup(app: INestApplication, email: string, name = 'Pessoa Teste'): Promise<Client> {
  const c = new Client(app);
  const r = await c.post('/auth/signup', { name, email, password: PASSWORD });
  if (r.status !== 201) throw new Error(`signup falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

const WEEK_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: '08:00', closesAt: '18:00' }));

export interface Clinic {
  owner: Client;
  orgId: string;
  unitId: string;
}

/** Proprietário + organização + primeira unidade (seg–sex, 08:00–18:00, São Paulo). */
export async function createClinic(app: INestApplication, ownerEmail: string, name = 'Clínica Teste', planKey = 'rede'): Promise<Clinic> {
  const owner = await signup(app, ownerEmail, 'Proprietária');
  const r = await owner.post('/orgs', {
    name,
    unit: { name: 'Centro', timezone: TZ },
    businessHours: WEEK_HOURS,
    planKey,
  });
  if (r.status !== 201) throw new Error(`criar organização falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return { owner, orgId: r.body.organizationId, unitId: r.body.unitId };
}

export async function roleId(client: Client, orgId: string, key: string): Promise<string> {
  const r = await client.get(`/orgs/${orgId}/roles`);
  const role = (r.body as { id: string; key: string }[]).find((x) => x.key === key);
  if (!role) throw new Error(`papel ${key} não encontrado`);
  return role.id;
}

/** Convida e aceita: devolve o cliente já autenticado como membro. */
export async function addMember(
  app: INestApplication,
  clinic: Clinic,
  email: string,
  role: string,
  scope: { allUnits: boolean; unitIds?: string[] } = { allUnits: true },
): Promise<{ client: Client; membershipId: string }> {
  const inv = await clinic.owner.post(`/orgs/${clinic.orgId}/invitations`, {
    email,
    roleId: await roleId(clinic.owner, clinic.orgId, role),
    allUnits: scope.allUnits,
    unitIds: scope.unitIds ?? [],
  });
  if (inv.status !== 201) throw new Error(`convite falhou: ${inv.status} ${JSON.stringify(inv.body)}`);
  const client = await signup(app, email, `Membro ${role}`);
  const acc = await client.post('/invitations/accept', { token: inv.body.token });
  if (acc.status !== 201) throw new Error(`aceite falhou: ${acc.status} ${JSON.stringify(acc.body)}`);
  return { client, membershipId: acc.body.membershipId };
}

export async function createProfessional(clinic: Clinic, displayName: string, opts: { membershipId?: string; unitIds?: string[] } = {}): Promise<string> {
  const r = await clinic.owner.post(`/orgs/${clinic.orgId}/professionals`, {
    displayName,
    membershipId: opts.membershipId,
    color: '#0f766e',
    unitIds: opts.unitIds ?? [clinic.unitId],
  });
  if (r.status !== 201) throw new Error(`profissional falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

export async function createChair(clinic: Clinic, name: string, unitId = clinic.unitId): Promise<string> {
  const r = await clinic.owner.post(`/orgs/${clinic.orgId}/chairs`, { unitId, name, kind: 'chair' });
  if (r.status !== 201) throw new Error(`cadeira falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

export async function createPatient(client: Client, orgId: string, fullName: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await client.post(`/orgs/${orgId}/patients`, { fullName, ...extra });
  if (r.status !== 201) throw new Error(`paciente falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Horário local de São Paulo (UTC-3) em ISO com offset. */
export function at(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00-03:00`;
}
