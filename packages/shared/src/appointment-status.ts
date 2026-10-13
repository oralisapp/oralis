import type { Permission } from './permissions';

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'arrived',
  'in_progress',
  'completed',
  'no_show',
  'cancelled',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Agendado',
  confirmed: 'Confirmado',
  arrived: 'Chegou',
  in_progress: 'Em atendimento',
  completed: 'Concluído',
  no_show: 'Faltou',
  cancelled: 'Cancelado',
};

/** Status que ainda ocupam o horário do profissional, da cadeira e do paciente. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = ['scheduled', 'confirmed', 'arrived', 'in_progress', 'completed'];

export const TERMINAL_STATUSES: readonly AppointmentStatus[] = ['completed', 'no_show', 'cancelled'];

interface TransitionRule {
  to: AppointmentStatus;
  /** Rótulo da ação na interface. */
  action: string;
  permission: Permission;
  requiresReason?: boolean;
}

/**
 * Máquina de estados da consulta. Qualquer transição fora desta tabela é
 * rejeitada pela API. Reagendar não é uma transição: é uma alteração de
 * horário que devolve a consulta para "Agendado" (exige nova confirmação).
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly TransitionRule[]> = {
  scheduled: [
    { to: 'confirmed', action: 'Confirmar presença', permission: 'schedule.confirm' },
    { to: 'arrived', action: 'Fazer check-in', permission: 'schedule.checkin' },
    { to: 'no_show', action: 'Registrar falta', permission: 'schedule.cancel' },
    { to: 'cancelled', action: 'Cancelar', permission: 'schedule.cancel', requiresReason: true },
  ],
  confirmed: [
    { to: 'arrived', action: 'Fazer check-in', permission: 'schedule.checkin' },
    { to: 'no_show', action: 'Registrar falta', permission: 'schedule.cancel' },
    { to: 'cancelled', action: 'Cancelar', permission: 'schedule.cancel', requiresReason: true },
  ],
  arrived: [
    { to: 'in_progress', action: 'Iniciar atendimento', permission: 'schedule.attend' },
    { to: 'cancelled', action: 'Cancelar', permission: 'schedule.cancel', requiresReason: true },
  ],
  in_progress: [{ to: 'completed', action: 'Concluir atendimento', permission: 'schedule.attend' }],
  completed: [],
  no_show: [],
  cancelled: [],
};

export function findTransition(from: AppointmentStatus, to: AppointmentStatus): TransitionRule | undefined {
  return APPOINTMENT_TRANSITIONS[from].find((t) => t.to === to);
}

export function isBlocking(status: AppointmentStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

export const CANCELLATION_REASONS = {
  patient_request: 'Solicitação do paciente',
  patient_unreachable: 'Paciente não confirmou / sem contato',
  professional_unavailable: 'Profissional indisponível',
  clinic_operational: 'Motivo operacional da clínica',
  rescheduled_elsewhere: 'Remarcado em outro horário',
  other: 'Outro motivo',
} as const;

export type CancellationReason = keyof typeof CANCELLATION_REASONS;
