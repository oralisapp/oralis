import { Inject, Injectable } from '@nestjs/common';
import { ASSIGNABLE_BY_MANAGER, type InviteInput, type SystemRoleKey } from '@oralis/shared';
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, forbidden, notFound } from '../../common/app-error';
import { type AuthContext, type RequestMeta, type TenantContext, canAccessUnit } from '../../common/request-context';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { clinicUnits, invitations, membershipUnits, memberships, organizations, roles, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { newToken, sha256 } from '../identity/session.service';
import { MailService, mailLayout } from '../platform/mail.service';
import { assertWithinLimit } from '../billing/billing.service';
import { env } from '../../config/env';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const updateMemberSchema = z
  .object({ roleId: z.uuid(), allUnits: z.boolean(), unitIds: z.array(z.uuid()).max(50).default([]) })
  .refine((v) => v.allUnits || v.unitIds.length > 0, { error: 'Selecione ao menos uma unidade.', path: ['unitIds'] });

@Injectable()
export class TeamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async listMembers(tenant: TenantContext) {
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        status: memberships.status,
        allUnits: memberships.allUnits,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.organizationId, tenant.organizationId), ne(memberships.status, 'removed')))
      .orderBy(asc(users.name));
    const units = rows.length
      ? await this.db.select().from(membershipUnits).where(inArray(membershipUnits.membershipId, rows.map((r) => r.membershipId)))
      : [];
    return rows.map((r) => ({ ...r, unitIds: units.filter((u) => u.membershipId === r.membershipId).map((u) => u.unitId) }));
  }

  /** Verifica papel e unidades pedidos e se o autor pode concedê-los. */
  private async checkGrant(tx: DbOrTx, tenant: TenantContext, roleId: string, allUnits: boolean, unitIds: string[]) {
    const [role] = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.organizationId, tenant.organizationId)));
    if (!role) throw notFound('Papel');
    if (tenant.roleKey !== 'owner' && !ASSIGNABLE_BY_MANAGER.includes(role.key as SystemRoleKey)) {
      throw forbidden('Somente o proprietário pode conceder este papel.');
    }
    // Ninguém concede acesso a unidades que ele próprio não alcança.
    if (allUnits && !tenant.allUnits) throw forbidden('Você não pode conceder acesso a todas as unidades.');
    if (!allUnits) {
      const found = await tx
        .select({ id: clinicUnits.id })
        .from(clinicUnits)
        .where(and(eq(clinicUnits.organizationId, tenant.organizationId), inArray(clinicUnits.id, unitIds)));
      if (found.length !== new Set(unitIds).size) throw notFound('Unidade');
      if (unitIds.some((u) => !canAccessUnit(tenant, u))) throw forbidden('Você não pode conceder acesso a esta unidade.');
    }
    return role;
  }

  async invite(auth: AuthContext, tenant: TenantContext, input: InviteInput, meta: RequestMeta) {
    const created = await this.db.transaction(async (tx) => {
      const role = await this.checkGrant(tx, tenant, input.roleId, input.allUnits, input.unitIds);
      await assertWithinLimit(tx, tenant.organizationId, 'users');
      const existing = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.organizationId, tenant.organizationId), eq(users.email, input.email), ne(memberships.status, 'removed')));
      if (existing.length) throw new AppError('conflict', 'Esta pessoa já faz parte da equipe.');

      // Um convite pendente por e-mail: o novo substitui o anterior.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.organizationId, tenant.organizationId), eq(invitations.email, input.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));

      const token = newToken();
      const [inv] = await tx
        .insert(invitations)
        .values({
          organizationId: tenant.organizationId,
          email: input.email,
          roleId: role.id,
          allUnits: input.allUnits,
          unitIds: input.allUnits ? [] : [...new Set(input.unitIds)],
          tokenHash: sha256(token),
          invitedBy: auth.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning({ id: invitations.id, expiresAt: invitations.expiresAt });
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: inv!.id,
        metadata: { roleKey: role.key, allUnits: input.allUnits, unitIds: input.unitIds },
        meta,
      });
      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenant.organizationId));
      return { id: inv!.id, expiresAt: inv!.expiresAt, token, roleName: role.key, orgName: org!.name };
    });
    // E-mail enviado depois da transação: o convite existe mesmo se o envio falhar
    // (há novas tentativas automáticas), e o link continua disponível para copiar.
    const link = `${env().WEB_ORIGIN}/convite/${created.token}`;
    const body = mailLayout(
      `Convite para ${created.orgName}`,
      [`${auth.name} convidou você para a equipe de ${created.orgName} no Oralis Cloud.`, 'O convite vale por 7 dias. Use uma conta com este mesmo e-mail para aceitar.'],
      { label: 'Aceitar convite', url: link },
    );
    const sent = await this.mail.send({ to: input.email, subject: `Convite para ${created.orgName} — Oralis Cloud`, organizationId: tenant.organizationId, ...body });
    return { id: created.id, expiresAt: created.expiresAt, token: created.token, emailDelivery: sent.delivery };
  }

  async listInvitations(tenant: TenantContext) {
    return this.db
      .select({ id: invitations.id, email: invitations.email, roleName: roles.name, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .where(
        and(
          eq(invitations.organizationId, tenant.organizationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(invitations.createdAt));
  }

  async revokeInvitation(auth: AuthContext, tenant: TenantContext, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.id, id), eq(invitations.organizationId, tenant.organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!r.length) throw notFound('Convite');
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'invitation.revoked', entityType: 'invitation', entityId: id, meta });
      return { ok: true };
    });
  }

  private async findValidInvitation(db: DbOrTx, token: string) {
    if (!token || token.length > 100) return undefined;
    const [inv] = await db
      .select({
        id: invitations.id,
        organizationId: invitations.organizationId,
        organizationName: organizations.name,
        email: invitations.email,
        roleId: invitations.roleId,
        roleName: roles.name,
        allUnits: invitations.allUnits,
        unitIds: invitations.unitIds,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .where(eq(invitations.tokenHash, sha256(token)));
    return inv;
  }

  async preview(token: string) {
    const inv = await this.findValidInvitation(this.db, token);
    if (!inv) throw notFound('Convite');
    const state = inv.acceptedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt < new Date() ? 'expired' : 'pending';
    return { organizationName: inv.organizationName, roleName: inv.roleName, email: inv.email, state };
  }

  async accept(auth: AuthContext, token: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const inv = await this.findValidInvitation(tx, token);
      if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) {
        throw notFound('Convite válido');
      }
      if (inv.email !== auth.email) {
        throw forbidden(`Este convite foi enviado para outro e-mail. Entre com a conta ${inv.email}.`);
      }
      const [prev] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.organizationId, inv.organizationId), eq(memberships.userId, auth.userId)));
      if (prev && prev.status !== 'removed') throw new AppError('conflict', 'Você já faz parte desta organização.');

      // Unidades removidas depois do convite são descartadas silenciosamente.
      const validUnits = inv.allUnits || !inv.unitIds.length
        ? []
        : (await tx.select({ id: clinicUnits.id }).from(clinicUnits).where(and(eq(clinicUnits.organizationId, inv.organizationId), inArray(clinicUnits.id, inv.unitIds)))).map((u) => u.id);

      let membershipId: string;
      if (prev) {
        await tx.update(memberships).set({ status: 'active', roleId: inv.roleId, allUnits: inv.allUnits, updatedAt: new Date() }).where(eq(memberships.id, prev.id));
        await tx.delete(membershipUnits).where(eq(membershipUnits.membershipId, prev.id));
        membershipId = prev.id;
      } else {
        const [m] = await tx
          .insert(memberships)
          .values({ organizationId: inv.organizationId, userId: auth.userId, roleId: inv.roleId, allUnits: inv.allUnits })
          .returning({ id: memberships.id });
        membershipId = m!.id;
      }
      if (validUnits.length) {
        await tx.insert(membershipUnits).values(validUnits.map((unitId) => ({ membershipId, unitId, organizationId: inv.organizationId })));
      }
      await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: auth.userId }).where(eq(invitations.id, inv.id));
      await this.audit.record(tx, {
        organizationId: inv.organizationId,
        actorUserId: auth.userId,
        action: 'invitation.accepted',
        entityType: 'invitation',
        entityId: inv.id,
        metadata: { membershipId },
        meta,
      });
      return { organizationId: inv.organizationId, membershipId };
    });
  }

  /**
   * Altera papel/unidades. A mudança vale na requisição seguinte do membro,
   * porque as permissões não ficam em cache na sessão.
   */
  async updateMember(auth: AuthContext, tenant: TenantContext, membershipId: string, input: z.infer<typeof updateMemberSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const target = await this.lockMember(tx, tenant, membershipId);
      const role = await this.checkGrant(tx, tenant, input.roleId, input.allUnits, input.unitIds);
      if (target.roleKey === 'owner' && tenant.roleKey !== 'owner') throw forbidden('Somente o proprietário altera outro proprietário.');
      if (target.roleKey === 'owner' && role.key !== 'owner') await this.ensureAnotherOwner(tx, tenant, membershipId);

      await tx.update(memberships).set({ roleId: role.id, allUnits: input.allUnits, updatedAt: new Date() }).where(eq(memberships.id, membershipId));
      await tx.delete(membershipUnits).where(eq(membershipUnits.membershipId, membershipId));
      if (!input.allUnits) {
        await tx.insert(membershipUnits).values([...new Set(input.unitIds)].map((unitId) => ({ membershipId, unitId, organizationId: tenant.organizationId })));
      }
      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        actorUserId: auth.userId,
        action: 'membership.updated',
        entityType: 'membership',
        entityId: membershipId,
        metadata: { fromRole: target.roleKey, toRole: role.key, allUnits: input.allUnits, unitIds: input.unitIds },
        meta,
      });
      return { ok: true };
    });
  }

  async removeMember(auth: AuthContext, tenant: TenantContext, membershipId: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const target = await this.lockMember(tx, tenant, membershipId);
      if (target.roleKey === 'owner') {
        if (tenant.roleKey !== 'owner') throw forbidden('Somente o proprietário remove outro proprietário.');
        await this.ensureAnotherOwner(tx, tenant, membershipId);
      }
      await tx.update(memberships).set({ status: 'removed', updatedAt: new Date() }).where(eq(memberships.id, membershipId));
      await this.audit.record(tx, { organizationId: tenant.organizationId, actorUserId: auth.userId, action: 'membership.removed', entityType: 'membership', entityId: membershipId, meta });
      return { ok: true };
    });
  }

  private async lockMember(tx: DbOrTx, tenant: TenantContext, membershipId: string) {
    const [target] = await tx
      .select({ id: memberships.id, roleKey: roles.key })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, tenant.organizationId), ne(memberships.status, 'removed')))
      .for('update', { of: memberships });
    if (!target) throw notFound('Membro');
    return target;
  }

  private async ensureAnotherOwner(tx: DbOrTx, tenant: TenantContext, exceptMembershipId: string) {
    const owners = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.organizationId, tenant.organizationId), eq(roles.key, 'owner'), eq(memberships.status, 'active'), ne(memberships.id, exceptMembershipId)));
    if (!owners.length) throw new AppError('conflict', 'A organização precisa manter ao menos um proprietário ativo.');
  }
}
