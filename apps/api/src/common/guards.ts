import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CSRF_HEADER, type Permission } from '@oralis/shared';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env';
import { DB, type Db } from '../db/db';
import { membershipUnits, memberships, organizations, plans, rolePermissions, roles, subscriptions, userMfa } from '../db/schema';
import { accessFor } from '../modules/billing/entitlements';
import { Clock } from './clock';
import { SESSION_COOKIE, SessionService } from '../modules/identity/session.service';
import { AppError, forbidden, notFound } from './app-error';
import { ALLOW_WHEN_INACTIVE, type AppRequest, IS_PUBLIC, REQUIRED_FEATURE, REQUIRED_PERMISSIONS, SKIP_CSRF } from './request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Requisições mutáveis precisam do cabeçalho x-oralis-csrf e, se o navegador
 * enviar Origin, ela deve ser a do front-end. Formulários de outros sites não
 * conseguem enviar cabeçalhos personalizados sem preflight CORS (que a API recusa).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [ctx.getHandler(), ctx.getClass()])) return true;
    const origin = req.get('origin');
    if (req.get(CSRF_HEADER) !== '1' || (origin && origin !== env().WEB_ORIGIN)) {
      throw new AppError('csrf_rejected', 'Requisição recusada por motivo de segurança. Recarregue a página.');
    }
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) throw new AppError('unauthenticated', 'Sua sessão expirou. Entre novamente.');
    req.auth = auth;
    return true;
  }
}

/**
 * Para toda rota com :orgId, carrega o vínculo ATIVO do usuário naquela
 * organização. Sem vínculo, responde 404 — não revela que a organização
 * existe. Depois verifica as permissões exigidas pela rota.
 *
 * Não existe "superusuário" que ignore esta verificação: a administração do
 * SaaS usa um ambiente separado (incremento futuro) e não passa por aqui.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const orgId = (req.params as Record<string, string | undefined>).orgId;

    if (!orgId) {
      if (required.length) throw new Error('Rota exige permissão mas não possui :orgId.');
      return true;
    }
    if (!req.auth) throw new AppError('unauthenticated', 'Entre para continuar.');
    if (!UUID_RE.test(orgId)) throw notFound('Organização');

    const [m] = await this.db
      .select({ membershipId: memberships.id, roleId: memberships.roleId, roleKey: roles.key, allUnits: memberships.allUnits, requireMfa: organizations.requireMfaPrivileged })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.organizationId, orgId),
          eq(memberships.userId, req.auth.userId),
          eq(memberships.status, 'active'),
          eq(organizations.status, 'active'),
        ),
      )
      .limit(1);
    if (!m) throw notFound('Organização');

    // Política da organização: proprietários e gestores precisam de MFA ativo.
    if (m.requireMfa && (m.roleKey === 'owner' || m.roleKey === 'manager')) {
      const [mfa] = await this.db.select({ enabledAt: userMfa.enabledAt }).from(userMfa).where(eq(userMfa.userId, req.auth.userId));
      if (!mfa?.enabledAt) {
        throw new AppError('mfa_required', 'Esta clínica exige verificação em duas etapas para o seu papel. Ative-a em Minha conta.');
      }
    }

    const [perms, units, subRows] = await Promise.all([
      this.db.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, m.roleId)),
      this.db.select({ u: membershipUnits.unitId }).from(membershipUnits).where(eq(membershipUnits.membershipId, m.membershipId)),
      this.db.select({ sub: subscriptions, features: plans.features }).from(subscriptions).innerJoin(plans, eq(plans.id, subscriptions.planId)).where(eq(subscriptions.organizationId, orgId)),
    ]);
    const access = accessFor(subRows[0]?.sub, this.clock.now());

    req.tenant = {
      organizationId: orgId,
      membershipId: m.membershipId,
      roleKey: m.roleKey,
      permissions: new Set(perms.map((r) => r.p as Permission)),
      allUnits: m.allUnits,
      unitIds: new Set(units.map((r) => r.u)),
      features: new Set(subRows[0]?.features ?? []),
      access: access.level,
    };

    // Assinatura inativa: leitura e exportação continuam; escrita é bloqueada.
    const allowInactive = this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_INACTIVE, [ctx.getHandler(), ctx.getClass()]);
    if (access.level === 'read_only' && !SAFE_METHODS.has(req.method) && !allowInactive) {
      throw new AppError('subscription_inactive', access.reason + ' A clínica está em modo somente leitura: os dados podem ser consultados e exportados. Regularize em Assinatura.');
    }
    const feature = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_FEATURE, [ctx.getHandler(), ctx.getClass()]);
    if (feature && !req.tenant.features.has(feature)) {
      throw new AppError('feature_disabled', 'Este recurso não faz parte do plano atual. Veja as opções em Assinatura.');
    }

    for (const p of required) {
      if (!req.tenant.permissions.has(p)) throw forbidden();
    }
    return true;
  }
}

/** Limita tentativas de login/cadastro por IP + e-mail. */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    return `${req.ip}|${email}`;
  }
}
