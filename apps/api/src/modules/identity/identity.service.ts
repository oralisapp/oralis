import { Inject, Injectable } from '@nestjs/common';
import type { LoginInput, Permission, SignupInput } from '@oralis/shared';
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { AppError } from '../../common/app-error';
import { Clock } from '../../common/clock';
import { env } from '../../config/env';
import type { AuthContext, RequestMeta } from '../../common/request-context';
import { DB, type Db, pgErrorCode } from '../../db/db';
import { clinicUnits, membershipUnits, memberships, organizations, passwordResetTokens, plans, professionals, rolePermissions, roles, sessions, subscriptions, users } from '../../db/schema';
import { accessFor } from '../billing/entitlements';
import { AuditService } from '../audit/audit.service';
import { MailService, mailLayout } from '../platform/mail.service';
import { MfaService } from './mfa.service';
import { hashPassword, verifyPassword } from './password';
import { SessionService, newToken, sha256 } from './session.service';

const RESET_TTL_MS = 60 * 60_000;

export type LoginResult = { kind: 'session'; token: string; expiresAt: Date } | { kind: 'mfa'; challengeToken: string };

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly mail: MailService,
    private readonly clock: Clock,
  ) {}

  async signup(input: SignupInput, meta: RequestMeta) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: input.email, name: input.name, passwordHash }).returning({ id: users.id });
        await this.audit.record(tx, { organizationId: null, actorUserId: user!.id, action: 'auth.signup', entityType: 'user', entityId: user!.id, meta });
        const session = await this.sessions.create(tx, user!.id, meta);
        return { userId: user!.id, ...session };
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') {
        throw new AppError('conflict', 'Já existe uma conta com este e-mail. Entre com sua senha.');
      }
      throw err;
    }
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const [user] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
    if (!user || !ok || user.disabledAt) {
      await this.audit.record(this.db, {
        organizationId: null,
        actorUserId: user?.id ?? null,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id ?? null,
        meta,
      });
      throw new AppError('unauthenticated', 'E-mail ou senha incorretos.');
    }
    return this.db.transaction(async (tx): Promise<LoginResult> => {
      if (await this.mfa.isEnabled(tx, user.id)) {
        return { kind: 'mfa', challengeToken: await this.mfa.createChallenge(tx, user.id) };
      }
      await this.audit.record(tx, { organizationId: null, actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, meta });
      return { kind: 'session', ...(await this.sessions.create(tx, user.id, meta)) };
    });
  }

  /** Segunda etapa do login com MFA. */
  async completeMfaLogin(challengeToken: string, code: string, meta: RequestMeta) {
    const userId = await this.mfa.completeChallenge(challengeToken, code);
    return this.db.transaction(async (tx) => {
      await this.audit.record(tx, { organizationId: null, actorUserId: userId, action: 'auth.login', entityType: 'user', entityId: userId, metadata: { mfa: true }, meta });
      return this.sessions.create(tx, userId, meta);
    });
  }

  /**
   * Pedido de redefinição. Responde igual exista ou não a conta, para não
   * revelar quais e-mails estão cadastrados.
   */
  async requestPasswordReset(email: string, meta: RequestMeta) {
    const [user] = await this.db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.email, email), isNull(users.disabledAt)));
    if (!user) return;
    const token = newToken();
    await this.db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(this.clock.now().getTime() + RESET_TTL_MS) });
    await this.audit.record(this.db, { organizationId: null, actorUserId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, meta });
    const body = mailLayout(
      'Redefinição de senha',
      [`Olá, ${user.name.split(' ')[0]}.`, 'Recebemos um pedido para redefinir a senha da sua conta no Oralis Cloud. O link vale por 1 hora e pode ser usado uma vez.', 'Se não foi você, ignore este e-mail; sua senha continua a mesma.'],
      { label: 'Criar nova senha', url: `${env().WEB_ORIGIN}/redefinir-senha?token=${token}` },
    );
    await this.mail.send({ to: email, subject: 'Redefinição de senha — Oralis Cloud', ...body });
  }

  /** Troca a senha pelo link e encerra todas as sessões abertas. */
  async resetPassword(token: string, password: string, meta: RequestMeta) {
    const hash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(passwordResetTokens)
        .where(and(eq(passwordResetTokens.tokenHash, sha256(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, this.clock.now())))
        .for('update');
      if (!t) throw new AppError('validation_failed', 'Link inválido ou expirado. Peça um novo.');
      await tx.update(passwordResetTokens).set({ usedAt: this.clock.now() }).where(eq(passwordResetTokens.userId, t.userId));
      await tx.update(users).set({ passwordHash: hash, updatedAt: this.clock.now() }).where(eq(users.id, t.userId));
      await tx.update(sessions).set({ revokedAt: this.clock.now() }).where(and(eq(sessions.userId, t.userId), isNull(sessions.revokedAt)));
      await this.audit.record(tx, { organizationId: null, actorUserId: t.userId, action: 'auth.password_reset', entityType: 'user', entityId: t.userId, meta });
    });
  }

  /** Troca de senha autenticada: exige a senha atual e encerra as demais sessões. */
  async changePassword(auth: AuthContext, current: string, next: string, meta: RequestMeta) {
    const [u] = await this.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, auth.userId));
    if (!(await verifyPassword(u?.passwordHash ?? null, current))) {
      throw new AppError('validation_failed', 'Senha atual incorreta.', [{ path: 'currentPassword', message: 'Senha atual incorreta.' }]);
    }
    const hash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hash, updatedAt: this.clock.now() }).where(eq(users.id, auth.userId));
      await tx.update(sessions).set({ revokedAt: this.clock.now() }).where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt), ne(sessions.id, auth.sessionId)));
      await this.audit.record(tx, { organizationId: null, actorUserId: auth.userId, action: 'auth.password_changed', entityType: 'user', entityId: auth.userId, meta });
    });
  }

  /** Dados do usuário e de cada organização em que ele tem vínculo ativo. */
  async me(auth: AuthContext) {
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        organizationId: organizations.id,
        organizationName: organizations.name,
        isDemo: organizations.isDemo,
        requireMfa: organizations.requireMfaPrivileged,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        allUnits: memberships.allUnits,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.userId, auth.userId), eq(memberships.status, 'active'), eq(organizations.status, 'active')))
      .orderBy(asc(organizations.name));

    const orgIds = rows.map((r) => r.organizationId);
    const roleIds = rows.map((r) => r.roleId);
    const membershipIds = rows.map((r) => r.membershipId);
    const subs = orgIds.length ? await this.db.select({ sub: subscriptions, planName: plans.name, features: plans.features }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(inArray(subscriptions.organizationId, orgIds)) : [];
    const [perms, units, scoped, profs] = orgIds.length
      ? await Promise.all([
          this.db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds)),
          this.db
            .select({ id: clinicUnits.id, organizationId: clinicUnits.organizationId, name: clinicUnits.name, timezone: clinicUnits.timezone })
            .from(clinicUnits)
            .where(and(inArray(clinicUnits.organizationId, orgIds), eq(clinicUnits.active, true)))
            .orderBy(asc(clinicUnits.name)),
          this.db.select().from(membershipUnits).where(inArray(membershipUnits.membershipId, membershipIds)),
          this.db
            .select({ id: professionals.id, membershipId: professionals.membershipId })
            .from(professionals)
            .where(inArray(professionals.organizationId, orgIds)),
        ])
      : [[], [], [], []];

    const mfaEnabled = await this.mfa.isEnabled(this.db, auth.userId);
    return {
      user: { id: auth.userId, name: auth.name, email: auth.email, mfaEnabled },
      memberships: rows.map((r) => {
        const allowed = new Set(scoped.filter((s) => s.membershipId === r.membershipId).map((s) => s.unitId));
        return {
          membershipId: r.membershipId,
          organizationId: r.organizationId,
          organizationName: r.organizationName,
          isDemo: r.isDemo,
          mfaRequired: r.requireMfa && (r.roleKey === 'owner' || r.roleKey === 'manager') && !mfaEnabled,
          role: { id: r.roleId, key: r.roleKey, name: r.roleName },
          permissions: perms.filter((p) => p.roleId === r.roleId).map((p) => p.permission as Permission),
          allUnits: r.allUnits,
          units: units.filter((u) => u.organizationId === r.organizationId && (r.allUnits || allowed.has(u.id))),
          professionalId: profs.find((p) => p.membershipId === r.membershipId)?.id ?? null,
          subscription: (() => {
            const s = subs.find((x) => x.sub.organizationId === r.organizationId);
            const access = accessFor(s?.sub, this.clock.now());
            return { status: s?.sub.status ?? null, planName: s?.planName ?? null, features: s?.features ?? [], trialEndsAt: s?.sub.trialEndsAt ?? null, access: access.level, accessReason: access.reason };
          })(),
        };
      }),
    };
  }
}
