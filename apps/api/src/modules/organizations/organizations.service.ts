import { Inject, Injectable } from '@nestjs/common';
import {
  type BusinessHoursInput,
  type CreateOrganizationInput,
  type Permission,
  SYSTEM_ROLES,
  type UnitInput,
  normalizeBrPhone,
} from '@oralis/shared';
import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import {
  appointments,
  businessHours,
  chairs,
  clinicUnits,
  invitations,
  memberships,
  organizations,
  patients,
  professionals,
  rolePermissions,
  roles,
  services,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../identity/mfa.service';
import { assertWithinLimit, createTrialSubscription } from '../billing/billing.service';
import { Clock } from '../../common/clock';

function unitValues(input: UnitInput) {
  return {
    name: input.name,
    timezone: input.timezone,
    phone: input.phone ? normalizeBrPhone(input.phone) : null,
    addressLine: input.addressLine ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
  };
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly clock: Clock,
  ) {}

  /** Política de segurança da organização. Quem ativa a exigência de MFA precisa ter MFA. */
  async updateSecurity(auth: AuthContext, tenant: TenantContext, requireMfaPrivileged: boolean, meta: RequestMeta) {
    if (requireMfaPrivileged && !(await this.mfa.isEnabled(this.db, auth.userId))) {
      throw new AppError('mfa_required', 'Ative a verificação em duas etapas na sua conta antes de exigi-la da equipe.');
    }
    await this.db.transaction(async (tx) => {
      await tx.update(organizations).set({ requireMfaPrivileged, updatedAt: new Date() }).where(eq(organizations.id, tenant.organizationId));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'org.security_updated', entityType: 'organization', entityId: tenant.organizationId, metadata: { requireMfaPrivileged }, meta });
    });
    return { ok: true };
  }

  /**
   * Cria a organização com os papéis de sistema, o vínculo de Proprietário
   * para quem criou e a primeira unidade com horário de funcionamento.
   */
  async create(auth: AuthContext, input: CreateOrganizationInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: input.name, createdBy: auth.userId }).returning({ id: organizations.id });
      const organizationId = org!.id;

      let ownerRoleId = '';
      for (const def of Object.values(SYSTEM_ROLES)) {
        const [role] = await tx
          .insert(roles)
          .values({ organizationId, key: def.key, name: def.name, description: def.description, isSystem: true })
          .returning({ id: roles.id });
        await tx.insert(rolePermissions).values(def.permissions.map((permission) => ({ roleId: role!.id, permission })));
        if (def.key === 'owner') ownerRoleId = role!.id;
      }

      const [membership] = await tx
        .insert(memberships)
        .values({ organizationId, userId: auth.userId, roleId: ownerRoleId, allUnits: true })
        .returning({ id: memberships.id });

      const [unit] = await tx.insert(clinicUnits).values({ organizationId, ...unitValues(input.unit) }).returning({ id: clinicUnits.id });
      await this.replaceHours(tx, organizationId, unit!.id, input.businessHours);
      await createTrialSubscription(tx, organizationId, input.planKey, this.clock.now());

      await this.audit.record(tx, { organizationId, actorUserId: auth.userId, action: 'org.created', entityType: 'organization', entityId: organizationId, meta });
      await this.audit.record(tx, {
        organizationId,
        actorUserId: auth.userId,
        action: 'unit.created',
        entityType: 'unit',
        entityId: unit!.id,
        unitId: unit!.id,
        meta,
      });
      return { organizationId, unitId: unit!.id, membershipId: membership!.id };
    });
  }

  async summary(tenant: TenantContext) {
    const [org] = await this.db
      .select({ id: organizations.id, name: organizations.name, isDemo: organizations.isDemo, requireMfaPrivileged: organizations.requireMfaPrivileged, createdAt: organizations.createdAt })
      .from(organizations)
      .where(eq(organizations.id, tenant.organizationId));
    return org;
  }

  async listUnits(tenant: TenantContext) {
    const rows = await this.db
      .select()
      .from(clinicUnits)
      .where(eq(clinicUnits.organizationId, tenant.organizationId))
      .orderBy(asc(clinicUnits.name));
    const visible = rows.filter((u) => canAccessUnit(tenant, u.id));
    const hours = visible.length
      ? await this.db.select().from(businessHours).where(inArray(businessHours.unitId, visible.map((u) => u.id))).orderBy(asc(businessHours.weekday), asc(businessHours.opensAt))
      : [];
    return visible.map((u) => ({
      ...u,
      businessHours: hours.filter((h) => h.unitId === u.id).map(({ weekday, opensAt, closesAt }) => ({ weekday, opensAt, closesAt })),
    }));
  }

  async createUnit(auth: AuthContext, tenant: TenantContext, input: UnitInput, hours: BusinessHoursInput, meta: RequestMeta) {
    // Quem atua só em algumas unidades não cria unidades novas.
    if (!tenant.allUnits) throw forbidden('Apenas quem atua em todas as unidades pode criar novas unidades.');
    return this.db.transaction(async (tx) => {
      await assertWithinLimit(tx, tenant.organizationId, 'units');
      const [unit] = await tx.insert(clinicUnits).values({ organizationId: tenant.organizationId, ...unitValues(input) }).returning();
      await this.replaceHours(tx, tenant.organizationId, unit!.id, hours);
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'unit.created',
        entityType: 'unit',
        entityId: unit!.id,
        unitId: unit!.id,
        meta,
      });
      return unit!;
    });
  }

  async updateUnit(auth: AuthContext, tenant: TenantContext, unitId: string, input: UnitInput, meta: RequestMeta) {
    if (!canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    return this.db.transaction(async (tx) => {
      const [unit] = await tx
        .update(clinicUnits)
        .set({ ...unitValues(input), updatedAt: new Date() })
        .where(and(eq(clinicUnits.id, unitId), eq(clinicUnits.organizationId, tenant.organizationId)))
        .returning();
      if (!unit) throw notFound('Unidade');
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'unit.updated',
        entityType: 'unit',
        entityId: unitId,
        unitId,
        metadata: { fields: Object.keys(input) },
        meta,
      });
      return unit;
    });
  }

  async updateHours(auth: AuthContext, tenant: TenantContext, unitId: string, hours: BusinessHoursInput, meta: RequestMeta) {
    if (!canAccessUnit(tenant, unitId)) throw notFound('Unidade');
    await this.db.transaction(async (tx) => {
      const [unit] = await tx
        .select({ id: clinicUnits.id })
        .from(clinicUnits)
        .where(and(eq(clinicUnits.id, unitId), eq(clinicUnits.organizationId, tenant.organizationId)))
        .for('update');
      if (!unit) throw notFound('Unidade');
      await this.replaceHours(tx, tenant.organizationId, unitId, hours);
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'unit.hours_updated',
        entityType: 'unit',
        entityId: unitId,
        unitId,
        metadata: { intervals: hours.length },
        meta,
      });
    });
    return { ok: true };
  }

  private async replaceHours(tx: DbOrTx, organizationId: string, unitId: string, hours: BusinessHoursInput) {
    await tx.delete(businessHours).where(and(eq(businessHours.unitId, unitId), eq(businessHours.organizationId, organizationId)));
    if (hours.length) {
      await tx.insert(businessHours).values(hours.map((h) => ({ organizationId, unitId, ...h })));
    }
  }

  /**
   * Checklist "Começar com o Oralis". Cada etapa é calculada a partir de
   * registros reais — nada é marcado como concluído manualmente.
   */
  async onboarding(tenant: TenantContext) {
    const org = tenant.organizationId;
    const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const [hours, profs, chairCount, serviceCount, members, invites, patientCount, apptCount, completed] = await Promise.all([
      n(this.db.select({ n: count() }).from(businessHours).where(eq(businessHours.organizationId, org))),
      n(this.db.select({ n: count() }).from(professionals).where(eq(professionals.organizationId, org))),
      n(this.db.select({ n: count() }).from(chairs).where(eq(chairs.organizationId, org))),
      n(this.db.select({ n: count() }).from(services).where(eq(services.organizationId, org))),
      n(this.db.select({ n: count() }).from(memberships).where(and(eq(memberships.organizationId, org), ne(memberships.status, 'removed')))),
      n(this.db.select({ n: count() }).from(invitations).where(eq(invitations.organizationId, org))),
      n(this.db.select({ n: count() }).from(patients).where(eq(patients.organizationId, org))),
      n(this.db.select({ n: count() }).from(appointments).where(eq(appointments.organizationId, org))),
      n(this.db.select({ n: count() }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.status, 'completed')))),
    ]);

    const steps: {
      key: string;
      title: string;
      description: string;
      done: boolean;
      optional: boolean;
      href: string;
      permission: Permission;
      dependsOn: string[];
    }[] = [
      { key: 'hours', title: 'Definir horários de funcionamento', description: 'A agenda só aceita consultas dentro do horário da unidade.', done: hours > 0, optional: false, href: '/app/configuracoes?secao=unidades', permission: 'units.manage', dependsOn: [] },
      { key: 'professionals', title: 'Cadastrar profissionais', description: 'Cada consulta pertence a um profissional, com cor própria na agenda.', done: profs > 0, optional: false, href: '/app/configuracoes?secao=profissionais', permission: 'professionals.manage', dependsOn: ['hours'] },
      { key: 'chairs', title: 'Configurar cadeiras e salas', description: 'Evita que duas consultas usem a mesma cadeira ao mesmo tempo.', done: chairCount > 0, optional: true, href: '/app/configuracoes?secao=cadeiras', permission: 'resources.manage', dependsOn: ['hours'] },
      { key: 'services', title: 'Configurar serviços e duração', description: 'Preenche a duração da consulta automaticamente ao agendar.', done: serviceCount > 0, optional: true, href: '/app/configuracoes?secao=servicos', permission: 'services.manage', dependsOn: [] },
      { key: 'team', title: 'Convidar a equipe', description: 'Cada pessoa entra com seu próprio acesso e papel.', done: members > 1 || invites > 0, optional: true, href: '/app/equipe', permission: 'team.manage', dependsOn: [] },
      { key: 'patients', title: 'Cadastrar o primeiro paciente', description: 'Comece pelos pacientes com consulta marcada.', done: patientCount > 0, optional: false, href: '/app/pacientes?novo=1', permission: 'patients.write', dependsOn: [] },
      { key: 'appointment', title: 'Criar o primeiro agendamento', description: 'Escolha paciente, profissional e horário na agenda.', done: apptCount > 0, optional: false, href: '/app/agenda', permission: 'schedule.write', dependsOn: ['professionals', 'patients'] },
      { key: 'attendance', title: 'Concluir o primeiro atendimento', description: 'Confirme, faça o check-in e conclua a consulta no fluxo do dia.', done: completed > 0, optional: false, href: '/app/visao-geral', permission: 'schedule.read', dependsOn: ['appointment'] },
    ];

    return {
      steps: steps.map((s) => ({ ...s, allowed: tenant.permissions.has(s.permission) })),
      requiredDone: steps.filter((s) => !s.optional && s.done).length,
      requiredTotal: steps.filter((s) => !s.optional).length,
    };
  }

  async listRoles(tenant: TenantContext) {
    const rows = await this.db
      .select({ id: roles.id, key: roles.key, name: roles.name, description: roles.description })
      .from(roles)
      .where(eq(roles.organizationId, tenant.organizationId))
      .orderBy(asc(roles.createdAt));
    const perms = rows.length ? await this.db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, rows.map((r) => r.id))) : [];
    return rows.map((r) => ({ ...r, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission) }));
  }
}
