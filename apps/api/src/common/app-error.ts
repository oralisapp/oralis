import type { ErrorCode } from '@oralis/shared';
import type { z } from 'zod';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  schedule_conflict: 409,
  outside_business_hours: 422,
  invalid_transition: 422,
  stale_version: 409,
  duplicate_patient: 409,
  rate_limited: 429,
  csrf_rejected: 403,
  mfa_required: 403,
  plan_limit: 402,
  subscription_inactive: 402,
  feature_disabled: 403,
  internal_error: 500,
};

/** Erro de domínio com código estável e mensagem em português para o usuário. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS_BY_CODE[code];
  }
}

export const notFound = (what = 'Registro') => new AppError('not_found', `${what} não encontrado.`);
export const forbidden = (message = 'Você não tem permissão para esta ação.') => new AppError('forbidden', message);

/** Valida a entrada com o esquema compartilhado e devolve o valor tipado. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      'validation_failed',
      r.error.issues[0]?.message ?? 'Dados inválidos.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
