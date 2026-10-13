/**
 * Códigos de erro estáveis devolvidos pela API em `{ error: { code, message, details } }`.
 * A interface decide a apresentação a partir do código, não do texto.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'schedule_conflict',
  'outside_business_hours',
  'invalid_transition',
  'stale_version',
  'duplicate_patient',
  'rate_limited',
  'csrf_rejected',
  'mfa_required',
  'plan_limit',
  'subscription_inactive',
  'feature_disabled',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface ScheduleConflictDetail {
  kind: 'professional' | 'chair' | 'patient' | 'block';
  reason?: string | null;
  appointmentId: string;
  startsAt: string;
  endsAt: string;
}

/** Cabeçalho exigido em toda requisição mutável (força preflight e bloqueia CSRF por formulário). */
export const CSRF_HEADER = 'x-oralis-csrf';
