/**
 * Dados de demonstração 100% fictícios: "Clínica Aurora".
 *
 * - Usa os mesmos serviços da API (validações, conflitos, histórico, auditoria).
 * - Reproduzível: gerador pseudoaleatório com semente fixa; as datas são
 *   relativas ao dia atual no fuso da clínica.
 * - Sem CPF, sem telefones e com e-mails em domínio reservado (.example),
 *   para que nenhum dado coincida com documentos ou contatos reais.
 * - Recusa rodar em produção e contra bancos que não sejam locais.
 *
 * Uso: npm run db:seed:demo            (cria, se ainda não existir)
 *      npm run db:seed:demo -- --reset (APAGA o banco de desenvolvimento e recria)
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import {
  type AppointmentStatus,
  CANCELLATION_REASONS,
  type CancellationReason,
  type Permission,
  dayRangeInTz,
  minutesToTime,
  parseTimeToMinutes,
  zonedParts,
  zonedToInstant,
} from '@oralis/shared';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { AppError } from '../common/app-error';
import { Clock } from '../common/clock';
import type { AuthContext, RequestMeta, TenantContext } from '../common/request-context';
import { env } from '../config/env';
import { IdentityService } from '../modules/identity/identity.service';
import { OrganizationsService } from '../modules/organizations/organizations.service';
import { ResourcesService } from '../modules/organizations/resources.service';
import { TeamService } from '../modules/organizations/team.service';
import { PatientsService } from '../modules/patients/patients.service';
import { SchedulingService } from '../modules/scheduling/scheduling.service';
import { DB, type Db } from './db';
import { organizations, rolePermissions, roles, users } from './schema';

const TZ = 'America/Sao_Paulo';
const META: RequestMeta = { ip: null, userAgent: 'seed-demo' };

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20300312);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

const FIRST = ['Ana', 'Bruno', 'Camila', 'Daniel', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Mateus', 'Natália', 'Otávio', 'Paula', 'Renato', 'Sofia', 'Tiago', 'Valéria', 'Yuri'];
const LAST = ['Albuquerque', 'Barros', 'Cardoso', 'Duarte', 'Esteves', 'Fontes', 'Guimarães', 'Holanda', 'Lacerda', 'Macedo', 'Nogueira', 'Pacheco', 'Queiroz', 'Rezende', 'Siqueira', 'Toledo'];

function slug(s: string) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z]+/g, '.');
}

function addDays(day: string, n: number): string {
  const { start } = dayRangeInTz(day, TZ);
  return zonedParts(new Date(start.getTime() + n * 86_400_000 + 12 * 3_600_000), TZ).date;
}

async function main() {
  const config = env();
  if (config.APP_ENV === 'production') throw new Error('Seed de demonstração recusado em produção.');
  const host = new URL(config.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost', 'postgres'].includes(host)) throw new Error(`Seed recusado: banco não local (${host}).`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get<Db>(DB);
  const clock = app.get(Clock);
  const realNow = new Date();
  let fakeNow: Date | null = null;
  clock.now = () => fakeNow ?? new Date();

  try {
    if (process.argv.includes('--reset')) {
      if (!new URL(config.DATABASE_URL).pathname.endsWith('_dev')) throw new Error('--reset só é permitido em bancos *_dev.');
      console.log('Apagando todos os dados do banco de desenvolvimento...');
      await db.execute(sql`
        TRUNCATE audit_events, appointment_status_history, appointments, patients, services, chairs,
          professional_units, professionals, invitations, membership_units, memberships, role_permissions,
          roles, business_hours, clinic_units, organizations, sessions, users RESTART IDENTITY CASCADE`);
    }
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, 'proprietaria@aurora.example'));
    if (exists.length) {
      console.log('A demonstração já existe. Para recriar do zero: npm run db:seed:demo -- --reset');
      return;
    }

    const password = process.env.SEED_DEMO_PASSWORD || randomBytes(9).toString('base64url');
    if (password.length < 10) throw new Error('SEED_DEMO_PASSWORD deve ter ao menos 10 caracteres.');
    const identity = app.get(IdentityService);
    const orgs = app.get(OrganizationsService);
    const team = app.get(TeamService);
    const resources = app.get(ResourcesService);
    const patientsSvc = app.get(PatientsService);
    const scheduling = app.get(SchedulingService);

    const accounts = [
      { email: 'proprietaria@aurora.example', name: 'Marina Aurora (fictícia)', role: null },
      { email: 'recepcao@aurora.example', name: 'Lucas Recepção (fictício)', role: 'reception' },
      { email: 'helena@aurora.example', name: 'Dra. Helena Prado (fictícia)', role: 'dentist' },
      { email: 'gestor@aurora.example', name: 'Paulo Gestão (fictício)', role: 'manager' },
    ] as const;
    const auths: Record<string, AuthContext> = {};
    for (const a of accounts) {
      const r = await identity.signup({ email: a.email, name: a.name, password }, META);
      auths[a.email] = { userId: r.userId, sessionId: '', email: a.email, name: a.name };
    }
    const owner = auths['proprietaria@aurora.example']!;

    const weekdayHours = (days: number[], ranges: [string, string][]) => days.flatMap((weekday) => ranges.map(([opensAt, closesAt]) => ({ weekday, opensAt, closesAt })));
    const created = await orgs.create(
      owner,
      {
        name: 'Clínica Aurora',
        unit: { name: 'Aurora Centro', timezone: TZ, addressLine: 'Endereço fictício, 100', city: 'Cidade Exemplo', state: 'SP' },
        businessHours: [...weekdayHours([1, 2, 3, 4, 5], [['08:00', '12:00'], ['13:00', '19:00']]), ...weekdayHours([6], [['08:00', '12:00']])],
      },
      META,
    );
    const orgId = created.organizationId;
    await db.update(organizations).set({ isDemo: true }).where(eq(organizations.id, orgId));

    const tenantFor = async (roleKey: string, membershipId: string): Promise<TenantContext> => {
      const [role] = await db.select().from(roles).where(sql`${roles.organizationId} = ${orgId} and ${roles.key} = ${roleKey}`);
      const perms = await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, role!.id));
      return { organizationId: orgId, membershipId, roleKey, permissions: new Set(perms.map((p) => p.permission as Permission)), allUnits: true, unitIds: new Set(), features: new Set<string>(), access: 'full' };
    };
    const ownerTenant = await tenantFor('owner', created.membershipId);

    const parque = await orgs.createUnit(owner, ownerTenant, { name: 'Aurora Parque', timezone: TZ, city: 'Cidade Exemplo', state: 'SP' }, weekdayHours([1, 2, 3, 4, 5], [['09:00', '18:00']]), META);
    const centroId = created.unitId;
    const parqueId = parque.id;

    // Equipe: convites aceitos pelas contas fictícias.
    const membershipByEmail: Record<string, string> = {};
    const roleRows = await db.select().from(roles).where(eq(roles.organizationId, orgId));
    for (const a of accounts) {
      if (!a.role) continue;
      const inv = await team.invite(owner, ownerTenant, { email: a.email, roleId: roleRows.find((r) => r.key === a.role)!.id, allUnits: true, unitIds: [] }, META);
      const acc = await team.accept(auths[a.email]!, inv.token, META);
      membershipByEmail[a.email] = acc.membershipId;
    }

    const profDefs = [
      { displayName: 'Dra. Helena Prado', specialties: ['Clínica geral'], color: '#0f766e', units: [centroId, parqueId], membershipId: membershipByEmail['helena@aurora.example'] },
      { displayName: 'Dr. Rafael Teixeira', specialties: ['Ortodontia'], color: '#2563eb', units: [centroId] },
      { displayName: 'Dra. Lívia Campos', specialties: ['Endodontia'], color: '#9333ea', units: [centroId, parqueId] },
      { displayName: 'Dr. Marcos Aragão', specialties: ['Implantodontia'], color: '#c2410c', units: [parqueId] },
    ];
    const profIds: string[] = [];
    for (const p of profDefs) {
      const r = await resources.saveProfessional(owner, ownerTenant, null, { displayName: p.displayName, specialties: p.specialties, color: p.color, unitIds: p.units, membershipId: p.membershipId, active: true }, META);
      profIds.push(r.id);
    }
    // Em que unidade cada profissional atende em cada dia da semana (1 = segunda).
    const rota: Record<number, Record<number, string>> = {
      0: { 1: centroId, 2: parqueId, 3: centroId, 4: parqueId, 5: centroId, 6: centroId },
      1: { 1: centroId, 2: centroId, 3: centroId, 4: centroId, 5: centroId },
      2: { 1: parqueId, 2: centroId, 3: parqueId, 4: centroId, 5: parqueId, 6: centroId },
      3: { 1: parqueId, 2: parqueId, 3: parqueId, 4: parqueId, 5: parqueId },
    };

    const chairIds: Record<string, string[]> = { [centroId]: [], [parqueId]: [] };
    for (const [unitId, names] of [[centroId, ['Cadeira 1', 'Cadeira 2', 'Cadeira 3']], [parqueId, ['Cadeira 1', 'Cadeira 2']]] as const) {
      for (const name of names) chairIds[unitId]!.push((await resources.saveChair(owner, ownerTenant, null, { unitId, name, kind: 'chair', active: true }, META)).id);
    }

    const serviceDefs = [
      { name: 'Avaliação inicial', durationMinutes: 30, price: undefined },
      { name: 'Profilaxia (limpeza)', durationMinutes: 45, price: '180.00' },
      { name: 'Restauração em resina', durationMinutes: 60, price: '250.00' },
      { name: 'Tratamento de canal — sessão', durationMinutes: 90, price: '650.00' },
      { name: 'Manutenção ortodôntica', durationMinutes: 30, price: '150.00' },
      { name: 'Consulta de retorno', durationMinutes: 30, price: undefined },
    ];
    const svc: { id: string; durationMinutes: number; name: string }[] = [];
    for (const s of serviceDefs) svc.push({ ...s, id: (await resources.saveService(owner, ownerTenant, null, { ...s, active: true }, META)).id });

    const patientIds: string[] = [];
    const usedNames = new Set<string>();
    while (patientIds.length < 30) {
      const fullName = `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}`;
      if (usedNames.has(fullName)) continue;
      usedNames.add(fullName);
      const year = 1950 + Math.floor(rand() * 60);
      const birthDate = `${year}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`;
      const r = await patientsSvc.create(owner, ownerTenant, {
        fullName,
        birthDate,
        email: rand() < 0.7 ? `${slug(fullName)}@paciente.example` : undefined,
        administrativeNotes: rand() < 0.15 ? 'Prefere horários no início da manhã.' : undefined,
      }, true, META);
      patientIds.push(r.id);
    }

    // Agenda: 6 dias úteis para trás, hoje e 7 dias à frente.
    const today = zonedParts(realNow, TZ).date;
    let createdCount = 0;
    let skipped = 0;
    const hoursByUnit: Record<string, { weekday: number; opensAt: string; closesAt: string }[]> = {};
    for (const u of await orgs.listUnits(ownerTenant)) hoursByUnit[u.id] = u.businessHours;

    for (let offset = -8; offset <= 7; offset++) {
      const day = addDays(today, offset);
      const weekday = zonedParts(zonedToInstant(day, '12:00', TZ), TZ).weekday;
      if (weekday === 0) continue;
      for (let pi = 0; pi < profIds.length; pi++) {
        const unitId = rota[pi]![weekday];
        if (!unitId) continue;
        const ranges = hoursByUnit[unitId]!.filter((h) => h.weekday === weekday);
        for (const range of ranges) {
          let cursor = parseTimeToMinutes(range.opensAt);
          const close = parseTimeToMinutes(range.closesAt);
          while (cursor < close) {
            const service = pi === 1 && rand() < 0.6 ? svc[4]! : pick(svc);
            if (cursor + service.durationMinutes > close) break;
            if (rand() < 0.55) {
              const startsAt = zonedToInstant(day, minutesToTime(cursor), TZ);
              const ok = await createAppointment(startsAt, service, unitId, profIds[pi]!);
              if (ok) createdCount++;
              else skipped++;
            }
            cursor += service.durationMinutes + (rand() < 0.3 ? 15 : 0);
          }
        }
      }
    }

    async function createAppointment(startsAt: Date, service: { id: string; durationMinutes: number }, unitId: string, professionalId: string) {
      const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
      const isPast = endsAt <= realNow;
      const isNow = startsAt <= realNow && endsAt > realNow;
      fakeNow = isPast || isNow ? new Date(startsAt.getTime() - 3 * 86_400_000) : null;
      try {
        const appt = await scheduling.create(owner, ownerTenant, {
          unitId,
          patientId: pick(patientIds),
          professionalId,
          chairId: rand() < 0.85 ? pick(chairIds[unitId]!) : undefined,
          serviceId: service.id,
          startsAt: startsAt.toISOString(),
          durationMinutes: service.durationMinutes,
          skipConflicts: false,
        }, META);

        const r = rand();
        let path: AppointmentStatus[];
        let reason: CancellationReason | undefined;
        if (isPast) {
          path = r < 0.78 ? ['confirmed', 'arrived', 'in_progress', 'completed'] : r < 0.9 ? ['no_show'] : ['cancelled'];
        } else if (isNow) {
          path = r < 0.6 ? ['confirmed', 'arrived', 'in_progress'] : ['confirmed', 'arrived'];
        } else {
          path = r < 0.5 ? ['confirmed'] : r < 0.9 ? [] : ['cancelled'];
        }
        if (path.includes('cancelled')) reason = pick(Object.keys(CANCELLATION_REASONS) as CancellationReason[]);

        let version = appt.version;
        for (const to of path) {
          fakeNow = isPast || isNow
            ? new Date(startsAt.getTime() + (to === 'confirmed' ? -86_400_000 : to === 'completed' ? (endsAt.getTime() - startsAt.getTime()) : 60_000))
            : null;
          if (isNow && to !== 'confirmed') fakeNow = new Date(Math.min(realNow.getTime(), startsAt.getTime() + 60_000));
          const res = await scheduling.transition(owner, ownerTenant, appt.id, { to, version, reason }, META);
          version = res.version;
        }
        return true;
      } catch (err) {
        if (err instanceof AppError && (err.code === 'schedule_conflict' || err.code === 'outside_business_hours')) return false;
        throw err;
      } finally {
        fakeNow = null;
      }
    }

    console.log('\nDemonstração criada (dados fictícios) — organização "Clínica Aurora".');
    console.log(`  Unidades: Aurora Centro e Aurora Parque · Profissionais: 4 · Pacientes: ${patientIds.length}`);
    console.log(`  Consultas criadas: ${createdCount} (horários pulados por conflito: ${skipped})`);
    console.log('\n  Contas de acesso (somente neste ambiente local):');
    for (const a of accounts) console.log(`    ${a.email.padEnd(30)} ${a.role ?? 'owner'}`);
    if (process.env.SEED_DEMO_PASSWORD) console.log('  Senha: a definida em SEED_DEMO_PASSWORD.');
    else console.log(`  Senha gerada (exibida só agora): ${password}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Falha no seed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
