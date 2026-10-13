import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@oralis/shared';
import type { Request } from 'express';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
}

/** Contexto da organização resolvido a partir do vínculo ativo do usuário. */
export interface TenantContext {
  organizationId: string;
  membershipId: string;
  roleKey: string | null;
  permissions: ReadonlySet<Permission>;
  allUnits: boolean;
  unitIds: ReadonlySet<string>;
  /** Recursos incluídos no plano da organização. */
  features: ReadonlySet<string>;
  /** full = uso normal; read_only = assinatura inativa (leitura e exportação). */
  access: 'full' | 'read_only';
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type AppRequest = Request & { auth?: AuthContext; tenant?: TenantContext };

export const IS_PUBLIC = 'oralis:public';
/** Rota acessível sem sessão (login, cadastro, prévia de convite). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'oralis:permissions';
/** Exige todas as permissões listadas na organização da rota. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const ALLOW_WHEN_INACTIVE = 'oralis:allowWhenInactive';
/** Rota de escrita permitida mesmo com a assinatura em somente-leitura (assinatura, exportação, suporte). */
export const AllowWhenInactive = () => SetMetadata(ALLOW_WHEN_INACTIVE, true);

export const REQUIRED_FEATURE = 'oralis:feature';
/** Exige que o plano da organização inclua o recurso. Verificado no backend. */
export const RequireFeature = (feature: string) => SetMetadata(REQUIRED_FEATURE, feature);

export const SKIP_CSRF = 'oralis:skipCsrf';
/** Somente para webhooks autenticados por assinatura do provedor. */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new Error('AuthContext ausente: rota pública usando @Auth().');
  return req.auth;
});

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.tenant) throw new Error('TenantContext ausente: rota sem :orgId.');
  return req.tenant;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return { ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 300) ?? null };
});

export function canAccessUnit(tenant: TenantContext, unitId: string): boolean {
  return tenant.allUnits || tenant.unitIds.has(unitId);
}
