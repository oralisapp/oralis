import { Inject, Injectable } from '@nestjs/common';
import type { ChairInput, ProfessionalInput, ServiceInput } from '@oralis/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { forbidden, notFound } from '../../common/app-error';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { chairs, clinicUnits, memberships, professionalUnits, professionals, services } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

/** Profissionais, cadeiras/salas e serviços: o que a agenda precisa para funcionar. */
@Injectable()
export class ResourcesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertUnits(tx: DbOrTx, tenant: TenantContext, unitIds: string[]) {
    const ids = [...new Set(unitIds)];
    const found = await tx
      .select({ id: clinicUnits.id })
      .from(clinicUnits)
      .where(and(eq(clinicUnits.organizationId, tenant.organizationId), inArray(clinicUnits.id, ids)));
    if (found.length !== ids.length) throw notFound('Unidade');
    if (ids.some((u) => !canAccessUnit(tenant, u))) throw forbidden('Você não atua nesta unidade.');
    return ids;
  }

  private async assertMembership(tx: DbOrTx, tenant: TenantContext, membershipId: string | undefined) {
    if (!membershipId) return null;
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, tenant.organizationId), eq(memberships.status, 'active')));
    if (!m) throw notFound('Membro da equipe');
    return m.id;
  }

  // ------------------------------------------------------------ Profissionais

  async listProfessionals(tenant: TenantContext) {
    const rows = await this.db
      .select()
      .from(professionals)
      .where(eq(professionals.organizationId, tenant.organizationId))
      .orderBy(asc(professionals.displayName));
    const links = rows.length
      ? await this.db.select().from(professionalUnits).where(inArray(professionalUnits.professionalId, rows.map((r) => r.id)))
      : [];
    return rows.map((r) => ({ ...r, unitIds: links.filter((l) => l.professionalId === r.id).map((l) => l.unitId) }));
  }

  async saveProfessional(auth: AuthContext, tenant: TenantContext, id: string | null, input: ProfessionalInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const unitIds = await this.assertUnits(tx, tenant, input.unitIds);
      const membershipId = await this.assertMembership(tx, tenant, input.membershipId);
      const values = {
        displayName: input.displayName,
        membershipId,
        croNumber: input.croNumber ?? null,
        croUf: input.croUf ?? null,
        specialties: input.specialties,
        color: input.color.toLowerCase(),
        active: input.active,
      };
      let professionalId: string;
      if (id) {
        const current = await tx
          .select({ id: professionals.id })
          .from(professionals)
          .where(and(eq(professionals.id, id), eq(professionals.organizationId, tenant.organizationId)))
          .for('update');
        if (!current.length) throw notFound('Profissional');
        // Quem atua só em algumas unidades não remove o profissional de unidades que não enxerga.
        const prevLinks = await tx.select().from(professionalUnits).where(eq(professionalUnits.professionalId, id));
        const hidden = prevLinks.filter((l) => !canAccessUnit(tenant, l.unitId)).map((l) => l.unitId);
        await tx.update(professionals).set({ ...values, updatedAt: new Date() }).where(eq(professionals.id, id));
        await tx.delete(professionalUnits).where(eq(professionalUnits.professionalId, id));
        unitIds.push(...hidden.filter((u) => !unitIds.includes(u)));
        professionalId = id;
      } else {
        const [p] = await tx.insert(professionals).values({ organizationId: tenant.organizationId, ...values }).returning({ id: professionals.id });
        professionalId = p!.id;
      }
      await tx.insert(professionalUnits).values(unitIds.map((unitId) => ({ professionalId, unitId, organizationId: tenant.organizationId })));
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: id ? 'professional.updated' : 'professional.created',
        entityType: 'professional',
        entityId: professionalId,
        metadata: { unitIds, linkedMembership: !!membershipId, active: input.active },
        meta,
      });
      return { id: professionalId };
    });
  }

  // ---------------------------------------------------------- Cadeiras/salas

  async listChairs(tenant: TenantContext) {
    const rows = await this.db
      .select()
      .from(chairs)
      .where(eq(chairs.organizationId, tenant.organizationId))
      .orderBy(asc(chairs.name));
    return rows.filter((c) => canAccessUnit(tenant, c.unitId));
  }

  async saveChair(auth: AuthContext, tenant: TenantContext, id: string | null, input: ChairInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      await this.assertUnits(tx, tenant, [input.unitId]);
      const values = { unitId: input.unitId, name: input.name, kind: input.kind, active: input.active };
      let chairId: string;
      if (id) {
        const [current] = await tx
          .select({ unitId: chairs.unitId })
          .from(chairs)
          .where(and(eq(chairs.id, id), eq(chairs.organizationId, tenant.organizationId)));
        if (!current || !canAccessUnit(tenant, current.unitId)) throw notFound('Cadeira');
        await tx.update(chairs).set({ ...values, updatedAt: new Date() }).where(eq(chairs.id, id));
        chairId = id;
      } else {
        const [c] = await tx.insert(chairs).values({ organizationId: tenant.organizationId, ...values }).returning({ id: chairs.id });
        chairId = c!.id;
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: id ? 'chair.updated' : 'chair.created',
        entityType: 'chair',
        entityId: chairId,
        unitId: input.unitId,
        metadata: { name: input.name, active: input.active },
        meta,
      });
      return { id: chairId };
    });
  }

  // ---------------------------------------------------------------- Serviços

  async listServices(tenant: TenantContext) {
    return this.db
      .select()
      .from(services)
      .where(eq(services.organizationId, tenant.organizationId))
      .orderBy(asc(services.name));
  }

  async saveService(auth: AuthContext, tenant: TenantContext, id: string | null, input: ServiceInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const values = { name: input.name, durationMinutes: input.durationMinutes, price: input.price ?? null, active: input.active };
      let serviceId: string;
      if (id) {
        const r = await tx
          .update(services)
          .set({ ...values, updatedAt: new Date() })
          .where(and(eq(services.id, id), eq(services.organizationId, tenant.organizationId)))
          .returning({ id: services.id });
        if (!r.length) throw notFound('Serviço');
        serviceId = id;
      } else {
        const [s] = await tx.insert(services).values({ organizationId: tenant.organizationId, ...values }).returning({ id: services.id });
        serviceId = s!.id;
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: id ? 'service.updated' : 'service.created',
        entityType: 'service',
        entityId: serviceId,
        metadata: { name: input.name, durationMinutes: input.durationMinutes, price: input.price ?? null },
        meta,
      });
      return { id: serviceId };
    });
  }
}
