import { APPOINTMENT_STATUS_LABEL, type AppointmentStatus } from '@oralis/shared';
import { Ban, CalendarClock, CheckCheck, CircleCheck, DoorOpen, Stethoscope, UserX } from 'lucide-react';

/**
 * Status sempre com ícone + texto: a informação nunca depende só da cor.
 */
export const STATUS_STYLE: Record<AppointmentStatus, { tone: string; bar: string; Icon: typeof CalendarClock }> = {
  scheduled: { tone: 'bg-surface-3 text-muted', bar: 'var(--border-strong)', Icon: CalendarClock },
  confirmed: { tone: 'bg-primary-soft text-primary-text', bar: 'var(--primary)', Icon: CircleCheck },
  arrived: { tone: 'bg-warning-soft text-warning', bar: 'var(--warning)', Icon: DoorOpen },
  in_progress: { tone: 'bg-info-soft text-info-text', bar: 'var(--info-text)', Icon: Stethoscope },
  completed: { tone: 'bg-accent-soft text-accent-text', bar: 'var(--accent)', Icon: CheckCheck },
  no_show: { tone: 'bg-danger-soft text-danger', bar: 'var(--danger)', Icon: UserX },
  cancelled: { tone: 'bg-surface-3 text-subtle line-through decoration-1', bar: 'var(--border)', Icon: Ban },
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${s.tone}`}>
      <s.Icon className="size-3.5" aria-hidden />
      {APPOINTMENT_STATUS_LABEL[status]}
    </span>
  );
}
