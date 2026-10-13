'use client';

import { BLOCKING_STATUSES, minutesToTime, parseTimeToMinutes, todayInTz, WEEKDAY_LABEL, zonedParts, zonedToInstant } from '@oralis/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CalendarDays, ChevronLeft, ChevronRight, ListChecks, Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AgendaOpportunities } from '@/components/agenda-opportunities';
import { AppointmentPanel } from '@/components/appointment-panel';
import { BlockDialog } from '@/components/block-dialog';
import { NewAppointmentDialog, type NewAppointmentDefaults } from '@/components/new-appointment-dialog';
import { STATUS_STYLE } from '@/components/status-badge';
import { Button, ButtonLink, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Checkbox, FormError, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtLongDay, fmtTime } from '@/lib/format';
import { type Agenda, type AgendaAppointment, BLOCK_KIND_LABEL, type ScheduleBlock, useAgenda, useAgendaRange } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const PX_PER_MIN = 1.4;
const SNAP = 15;
type View = 'day' | 'week' | 'month';

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}
function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}
function startOfWeek(day: string) {
  return shiftDay(day, -((weekdayOf(day) + 6) % 7)); // semana começando na segunda
}
function startOfMonthGrid(day: string) {
  return startOfWeek(`${day.slice(0, 8)}01`);
}

/** Distribui itens sobrepostos lado a lado na mesma coluna. */
function layoutColumn<T extends { id: string; startsAt: string; endsAt: string }>(items: T[]) {
  const sorted = [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const out = new Map<string, { col: number; cols: number }>();
  let cluster: { a: T; col: number }[] = [];
  let clusterEnd = '';
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    cluster.forEach((c) => out.set(c.a.id, { col: c.col, cols }));
    cluster = [];
  };
  for (const a of sorted) {
    if (cluster.length && a.startsAt >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.a.endsAt > a.startsAt).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ a, col });
    clusterEnd = clusterEnd && clusterEnd > a.endsAt ? clusterEnd : a.endsAt;
  }
  flush();
  return out;
}

interface Column {
  id: string;
  title: string;
  subtitle?: string;
  color: string;
  date: string;
  items: AgendaAppointment[];
  blocks: ScheduleBlock[];
  /** Usado pelo clique/arrastar: profissional ou cadeira da coluna. */
  professionalId?: string;
  chairId?: string | null;
}

interface MoveIntent {
  appointment: AgendaAppointment;
  date: string;
  time: string;
  professionalId: string;
  chairId: string | null;
}

/** Grade de horários reutilizada nas visões de dia e semana. */
function TimeGrid({ columns, tz, hours, dayStart, dayEnd, canWrite, profColor, onSlot, onOpen, onMove }: {
  columns: Column[];
  tz: string;
  hours: { weekday: number; opensAt: string; closesAt: string }[];
  dayStart: number;
  dayEnd: number;
  canWrite: boolean;
  profColor: (id: string) => string | undefined;
  onSlot: (c: Column, time: string) => void;
  onOpen: (id: string) => void;
  onMove: (m: MoveIntent) => void;
}) {
  const height = (dayEnd - dayStart) * PX_PER_MIN;
  const [now, setNow] = useState(() => new Date());
  const [dragging, setDragging] = useState<AgendaAppointment | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowParts = zonedParts(now, tz);
  const hourMarks: number[] = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) hourMarks.push(m);

  const minutesAt = (e: React.MouseEvent | React.DragEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return Math.min(dayEnd - SNAP, Math.max(dayStart, dayStart + Math.floor((e.clientY - rect.top) / PX_PER_MIN / SNAP) * SNAP));
  };

  const closedFor = (date: string) => {
    const wd = weekdayOf(date);
    const list = hours.filter((h) => h.weekday === wd).sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    const closed: [number, number][] = [];
    let cursor = dayStart;
    for (const h of list) {
      const o = parseTimeToMinutes(h.opensAt);
      if (o > cursor) closed.push([cursor, o]);
      cursor = Math.max(cursor, parseTimeToMinutes(h.closesAt));
    }
    if (cursor < dayEnd) closed.push([cursor, dayEnd]);
    return closed;
  };

  const minuteOf = (iso: string, date: string, isEnd: boolean) => {
    const p = zonedParts(new Date(iso), tz);
    if (p.date < date) return dayStart;
    if (p.date > date) return dayEnd;
    return isEnd && p.minutes === 0 ? 24 * 60 : p.minutes;
  };

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-full" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))` }}>
        <div className="sticky left-0 z-20 border-b border-border bg-surface" />
        {columns.map((c) => (
          <div key={c.id} className="flex items-center gap-2 border-b border-l border-border bg-surface px-3 py-2.5">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">{c.title}</span>
              {c.subtitle && <span className="block text-xs text-muted">{c.subtitle}</span>}
            </span>
            <span className="ml-auto text-xs text-subtle tabular-nums">{c.items.filter((a) => BLOCKING_STATUSES.includes(a.status)).length}</span>
          </div>
        ))}

        <div className="sticky left-0 z-20 bg-surface" style={{ height }}>
          {hourMarks.map((m) => (
            <span key={m} className="absolute right-2 -translate-y-1/2 text-[11px] font-medium text-subtle tabular-nums" style={{ top: (m - dayStart) * PX_PER_MIN }}>
              {minutesToTime(m)}
            </span>
          ))}
        </div>

        {columns.map((c) => {
          const layout = layoutColumn(c.items);
          const isToday = nowParts.date === c.date;
          return (
            <div
              key={c.id}
              className={`relative border-l border-border ${canWrite ? 'cursor-copy' : ''} ${dragging ? 'bg-primary-soft/20' : ''}`}
              style={{
                height,
                backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${60 * PX_PER_MIN}px)`,
                backgroundPositionY: `${((60 - (dayStart % 60)) % 60) * PX_PER_MIN}px`,
              }}
              onClick={(e) => canWrite && e.target === e.currentTarget && onSlot(c, minutesToTime(minutesAt(e, e.currentTarget)))}
              onDragOver={(e) => dragging && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragging) return;
                const time = minutesToTime(minutesAt(e, e.currentTarget));
                onMove({ appointment: dragging, date: c.date, time, professionalId: c.professionalId ?? dragging.professionalId, chairId: c.chairId !== undefined ? c.chairId : dragging.chairId });
                setDragging(null);
              }}
              aria-label={`Coluna ${c.title}${c.subtitle ? `, ${c.subtitle}` : ''}`}
            >
              {closedFor(c.date).map(([s, e]) => (
                <div key={s} aria-hidden className="pointer-events-none absolute inset-x-0 bg-surface-3/70" style={{ top: (s - dayStart) * PX_PER_MIN, height: (e - s) * PX_PER_MIN, backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, var(--border) 6px 7px)' }} />
              ))}
              {c.blocks.map((b) => {
                const s = minuteOf(b.startsAt, c.date, false);
                const e = Math.min(dayEnd, minuteOf(b.endsAt, c.date, true));
                if (e <= s) return null;
                return (
                  <div key={b.id} className="pointer-events-none absolute inset-x-1 z-[1] flex items-start gap-1 overflow-hidden rounded-md border border-dashed border-border-strong bg-surface-2/90 px-2 py-1 text-[11px] font-semibold text-muted" style={{ top: (s - dayStart) * PX_PER_MIN, height: (e - s) * PX_PER_MIN }}>
                    <Ban className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span className="truncate">{BLOCK_KIND_LABEL[b.kind]}{b.reason ? ` · ${b.reason}` : ''}</span>
                  </div>
                );
              })}
              {isToday && nowParts.minutes >= dayStart && nowParts.minutes <= dayEnd && (
                <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (nowParts.minutes - dayStart) * PX_PER_MIN }} />
              )}
              {c.items.map((a) => {
                const s = minuteOf(a.startsAt, c.date, false);
                const e = Math.min(dayEnd, minuteOf(a.endsAt, c.date, true));
                const pos = layout.get(a.id) ?? { col: 0, cols: 1 };
                const style = STATUS_STYLE[a.status];
                const inactive = a.status === 'cancelled' || a.status === 'no_show';
                const movable = canWrite && (a.status === 'scheduled' || a.status === 'confirmed');
                const h = Math.max(22, (e - s) * PX_PER_MIN - 2);
                return (
                  <button
                    key={a.id}
                    type="button"
                    draggable={movable}
                    onDragStart={(ev) => {
                      ev.dataTransfer.effectAllowed = 'move';
                      ev.dataTransfer.setData('text/plain', a.id);
                      setDragging(a);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => onOpen(a.id)}
                    aria-label={`${fmtTime(a.startsAt, tz)} a ${fmtTime(a.endsAt, tz)}, ${a.patientSocialName || a.patientName}, ${a.status}`}
                    className={`absolute z-[2] overflow-hidden rounded-lg border border-border bg-surface px-2 py-1 text-left shadow-card transition hover:z-10 hover:shadow-pop ${inactive ? 'opacity-55' : ''} ${movable ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging?.id === a.id ? 'opacity-40' : ''}`}
                    style={{
                      top: (s - dayStart) * PX_PER_MIN + 1,
                      height: h,
                      left: `calc(${(pos.col / pos.cols) * 100}% + 3px)`,
                      width: `calc(${100 / pos.cols}% - 6px)`,
                      borderLeft: `4px solid ${profColor(a.professionalId) ?? style.bar}`,
                    }}
                  >
                    <span className="flex items-center gap-1 text-[11px] font-bold text-muted tabular-nums">
                      <style.Icon className="size-3" aria-hidden />
                      {fmtTime(a.startsAt, tz)}
                    </span>
                    <span className={`block truncate text-[13px] font-semibold leading-tight ${a.status === 'cancelled' ? 'line-through' : ''}`}>{a.patientSocialName || a.patientName}</span>
                    {h > 50 && <span className="block truncate text-[11px] text-muted">{a.serviceName ?? ''}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function boundsOf(hours: { opensAt: string; closesAt: string }[]) {
  return {
    dayStart: hours.length ? Math.min(...hours.map((h) => parseTimeToMinutes(h.opensAt))) : 8 * 60,
    dayEnd: hours.length ? Math.max(...hours.map((h) => parseTimeToMinutes(h.closesAt))) : 18 * 60,
  };
}

function DayView({ agenda, view, showInactive, canWrite, onSlot, onOpen, onMove }: {
  agenda: Agenda;
  view: 'professional' | 'chair';
  showInactive: boolean;
  canWrite: boolean;
  onSlot: (d: NewAppointmentDefaults) => void;
  onOpen: (id: string) => void;
  onMove: (m: MoveIntent) => void;
}) {
  const visible = agenda.appointments.filter((a) => showInactive || (a.status !== 'cancelled' && a.status !== 'no_show'));
  const unitWide = agenda.blocks.filter((b) => !b.professionalId && !b.chairId);
  const columns: Column[] =
    view === 'professional'
      ? agenda.professionals.map((p) => ({ id: p.id, title: p.displayName, color: p.color, date: agenda.date, professionalId: p.id, items: visible.filter((a) => a.professionalId === p.id), blocks: [...unitWide, ...agenda.blocks.filter((b) => b.professionalId === p.id)] }))
      : [
          ...agenda.chairs.map((c) => ({ id: c.id, title: c.name, color: 'var(--primary)', date: agenda.date, chairId: c.id, items: visible.filter((a) => a.chairId === c.id), blocks: [...unitWide, ...agenda.blocks.filter((b) => b.chairId === c.id)] })),
          ...(visible.some((a) => !a.chairId) ? [{ id: 'none', title: 'Sem cadeira', color: 'var(--border-strong)', date: agenda.date, chairId: null, items: visible.filter((a) => !a.chairId), blocks: unitWide }] : []),
        ];
  if (!columns.length) {
    return (
      <EmptyState
        icon={<CalendarDays className="size-5" aria-hidden />}
        title={view === 'professional' ? 'Nenhum profissional atende nesta unidade' : 'Nenhuma cadeira configurada nesta unidade'}
        description="Cadastre em Configurações para montar a agenda."
        action={<ButtonLink href={`/app/configuracoes?secao=${view === 'professional' ? 'profissionais' : 'cadeiras'}`} variant="secondary">Ir para Configurações</ButtonLink>}
      />
    );
  }
  const colorOf = new Map(agenda.professionals.map((p) => [p.id, p.color]));
  const { dayStart, dayEnd } = boundsOf(agenda.businessHours);
  return (
    <TimeGrid
      columns={columns}
      tz={agenda.unit.timezone}
      hours={agenda.businessHours}
      dayStart={dayStart}
      dayEnd={dayEnd}
      canWrite={canWrite}
      profColor={(id) => (view === 'chair' ? colorOf.get(id) : undefined)}
      onSlot={(c, time) => onSlot({ date: c.date, time, professionalId: c.professionalId, chairId: c.chairId ?? undefined })}
      onOpen={onOpen}
      onMove={onMove}
    />
  );
}

function WeekView({ unitId, from, professionalId, showInactive, canWrite, onSlot, onOpen, onMove, onProfessionals }: {
  unitId: string;
  from: string;
  professionalId: string;
  showInactive: boolean;
  canWrite: boolean;
  onSlot: (d: NewAppointmentDefaults) => void;
  onOpen: (id: string) => void;
  onMove: (m: MoveIntent) => void;
  onProfessionals: (p: Agenda['professionals']) => void;
}) {
  const to = shiftDay(from, 6);
  const q = useAgendaRange(unitId, from, to);
  useEffect(() => {
    if (q.data) onProfessionals(q.data.professionals);
  }, [q.data, onProfessionals]);
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const tz = q.data.unit.timezone;
  const prof = professionalId || q.data.professionals[0]?.id || '';
  const color = q.data.professionals.find((p) => p.id === prof)?.color ?? 'var(--primary)';
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(from, i));
  const columns: Column[] = days.map((d) => ({
    id: d,
    date: d,
    title: WEEKDAY_LABEL[weekdayOf(d)]!,
    subtitle: d.split('-').reverse().slice(0, 2).join('/'),
    color,
    professionalId: prof,
    items: q.data!.appointments.filter((a) => a.professionalId === prof && zonedParts(new Date(a.startsAt), tz).date === d && (showInactive || (a.status !== 'cancelled' && a.status !== 'no_show'))),
    blocks: q.data!.blocks.filter((b) => (!b.professionalId && !b.chairId) || b.professionalId === prof),
  }));
  const { dayStart, dayEnd } = boundsOf(q.data.businessHours);
  return (
    <TimeGrid
      columns={columns}
      tz={tz}
      hours={q.data.businessHours}
      dayStart={dayStart}
      dayEnd={dayEnd}
      canWrite={canWrite}
      profColor={() => undefined}
      onSlot={(c, time) => onSlot({ date: c.date, time, professionalId: prof })}
      onOpen={onOpen}
      onMove={onMove}
    />
  );
}

function MonthView({ unitId, month, onPick }: { unitId: string; month: string; onPick: (d: string) => void }) {
  const from = startOfMonthGrid(month);
  const to = shiftDay(from, 41);
  const q = useAgendaRange(unitId, from, to);
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  const tz = q.data.unit.timezone;
  const today = todayInTz(tz);
  const days = Array.from({ length: 42 }, (_, i) => shiftDay(from, i));
  const count = (d: string) => q.data!.appointments.filter((a) => BLOCKING_STATUSES.includes(a.status) && zonedParts(new Date(a.startsAt), tz).date === d).length;
  const blocked = (d: string) => q.data!.blocks.some((b) => zonedParts(new Date(b.startsAt), tz).date <= d && zonedParts(new Date(b.endsAt), tz).date >= d);
  const open = (d: string) => q.data!.businessHours.some((h) => h.weekday === weekdayOf(d));
  return (
    <div className="p-3">
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-muted">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => <div key={d} className="py-1">{WEEKDAY_LABEL[d]!.slice(0, 3)}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const n = count(d);
          const inMonth = d.slice(0, 7) === month.slice(0, 7);
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              aria-label={`${fmtLongDay(d)}: ${n} consulta(s)${blocked(d) ? ', com bloqueio' : ''}`}
              className={`flex min-h-20 flex-col rounded-lg border p-2 text-left transition hover:border-primary/50 ${inMonth ? 'border-border bg-surface' : 'border-transparent bg-surface-2/50 text-subtle'} ${!open(d) ? 'opacity-60' : ''}`}
            >
              <span className={`text-sm font-bold tabular-nums ${d === today ? 'flex size-6 items-center justify-center rounded-full bg-primary text-on-primary' : ''}`}>{Number(d.slice(8))}</span>
              {n > 0 && <span className="mt-auto text-xs font-semibold text-primary-text">{n} consulta{n > 1 ? 's' : ''}</span>}
              {blocked(d) && <span className="text-[11px] text-muted">bloqueio</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgendaContent() {
  const { unit, can, orgId, membership, setUnitId } = useOrg();
  const params = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const [date, setDate] = useState(() => todayInTz(tz));
  const [mode, setMode] = useState<View>('day');
  const [view, setView] = useState<'professional' | 'chair'>('professional');
  const [weekProf, setWeekProf] = useState('');
  const [weekProfs, setWeekProfs] = useState<Agenda['professionals']>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState<NewAppointmentDefaults | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [move, setMove] = useState<MoveIntent | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const agenda = useAgenda(unit?.id, date);
  const requestedPatient = params.get('paciente');
  const patient = useQuery({ queryKey: ['org', orgId, 'return-patient', requestedPatient], queryFn: () => api.get<{ patient: { id: string; fullName: string; socialName: string | null } }>(`/orgs/${orgId}/patients/${requestedPatient}`), enabled: !!requestedPatient && /^[0-9a-f-]{36}$/i.test(requestedPatient) && params.get('novo') === '1' && can('schedule.write') && can('patients.read'), refetchOnWindowFocus: false });
  const [openedReturn, setOpenedReturn] = useState('');
  useEffect(() => {
    const targetUnit = params.get('unidade');
    if (targetUnit && targetUnit !== unit?.id) return;
    if (params.get('novo') !== '1' || !patient.data || !agenda.data || openedReturn === params.toString()) return;
    const p = patient.data.patient;
    setCreating({ date, time: '09:00', patient: { id: p.id, name: p.socialName ?? p.fullName } });
    setOpenedReturn(params.toString());
  }, [params, unit?.id, patient.data, agenda.data, date, openedReturn]);
  const today = todayInTz(tz);
  const appliedNavigation = useRef('');
  useEffect(() => {
    const navigationKey = `${orgId}:${params.toString()}`;
    if (appliedNavigation.current === navigationKey) return;
    const requestedUnit = params.get('unidade');
    if (requestedUnit && !membership.units.some((u) => u.id === requestedUnit)) return;
    if (requestedUnit && unit?.id !== requestedUnit) { setUnitId(requestedUnit); return; }
    appliedNavigation.current = navigationKey;
    const requestedDate = params.get('data');
    if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && !Number.isNaN(Date.parse(requestedDate))) setDate(requestedDate);
    const appointment = params.get('consulta');
    if (appointment && /^[0-9a-f-]{36}$/i.test(appointment)) setOpenId(appointment);
  }, [params, membership.units, setUnitId, unit?.id, orgId]);

  const counts = useMemo(() => {
    const list = agenda.data?.appointments ?? [];
    return { inactive: list.filter((a) => a.status === 'cancelled' || a.status === 'no_show').length };
  }, [agenda.data]);

  if (!can('schedule.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;

  const step = mode === 'day' ? 1 : mode === 'week' ? 7 : 0;
  const go = (dir: number) => {
    if (mode === 'month') {
      const [y, m] = date.split('-').map(Number);
      setDate(new Date(Date.UTC(y!, m! - 1 + dir, 1)).toISOString().slice(0, 10));
    } else setDate(shiftDay(date, dir * step));
  };
  const weekFrom = startOfWeek(date);
  const title =
    mode === 'day'
      ? `${fmtLongDay(date)}${date === today ? ' (hoje)' : ''}`
      : mode === 'week'
        ? `Semana de ${weekFrom.split('-').reverse().slice(0, 2).join('/')} a ${shiftDay(weekFrom, 6).split('-').reverse().slice(0, 2).join('/')}`
        : new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date.slice(0, 8)}15T12:00:00Z`));

  async function confirmMove() {
    if (!move) return;
    setMoving(true);
    setMoveError(null);
    const a = move.appointment;
    try {
      await api.put(`/orgs/${orgId}/appointments/${a.id}/schedule`, {
        professionalId: move.professionalId,
        chairId: move.chairId,
        startsAt: zonedToInstant(move.date, move.time, tz).toISOString(),
        durationMinutes: Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60_000),
        version: a.version,
      });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({ tone: 'success', title: 'Consulta movida', description: a.status === 'confirmed' ? 'A confirmação anterior deixou de valer.' : undefined });
      setMove(null);
    } catch (err) {
      setMoveError(err instanceof ApiError ? err.message : 'Não foi possível mover.');
    } finally {
      setMoving(false);
    }
  }

  const agendaForDialogs = agenda.data ?? null;

  return (
    <>
      {patient.error && <ErrorState error={patient.error} />}
      <PageHeader
        eyebrow="Seu dia, bem organizado"
        title="Agenda"
        description={unit ? `${unit.name} · ${title}` : undefined}
        actions={
          <>
            <ButtonLink href="/app/agenda/lista-de-espera" variant="secondary" icon={<ListChecks className="size-4" aria-hidden />}>
              Lista de espera
            </ButtonLink>
            {can('schedule.write') && agendaForDialogs && (
              <>
                <Button variant="secondary" icon={<Ban className="size-4" aria-hidden />} onClick={() => setBlocking(true)}>
                  Bloquear
                </Button>
                <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating({ date, time: date === today ? minutesToTime(Math.min(23 * 60, Math.ceil(zonedParts(new Date(), tz).minutes / SNAP) * SNAP)) : '09:00' })}>
                  Novo agendamento
                </Button>
              </>
            )}
          </>
        }
      />

      {unit && mode === 'day' && can('schedule.write') && <AgendaOpportunities key={`${unit.id}:${date}`} unitId={unit.id} date={date} tz={tz} />}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-2/30 px-5 py-4">
          <div className="flex items-center gap-1">
            <IconButton label="Anterior" onClick={() => go(-1)}><ChevronLeft className="size-5" aria-hidden /></IconButton>
            <Button variant="secondary" size="sm" onClick={() => setDate(today)} disabled={date === today}>Hoje</Button>
            <IconButton label="Próximo" onClick={() => go(1)}><ChevronRight className="size-5" aria-hidden /></IconButton>
            <input type="date" aria-label="Escolher data" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="ml-1 h-8 rounded-lg border border-border bg-surface px-2 text-sm" />
          </div>
          <div role="radiogroup" aria-label="Período" className="flex rounded-lg bg-surface-2 p-0.5">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button key={v} role="radio" aria-checked={mode === v} type="button" onClick={() => setMode(v)} className={`rounded-md px-3 py-1 text-sm font-semibold ${mode === v ? 'bg-surface text-fg shadow-card' : 'text-muted'}`}>
                {v === 'day' ? 'Dia' : v === 'week' ? 'Semana' : 'Mês'}
              </button>
            ))}
          </div>
          {mode === 'day' && (
            <div role="radiogroup" aria-label="Visualizar por" className="flex rounded-lg bg-surface-2 p-0.5">
              {(['professional', 'chair'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={view === v} type="button" onClick={() => setView(v)} className={`rounded-md px-3 py-1 text-sm font-semibold ${view === v ? 'bg-surface text-fg shadow-card' : 'text-muted'}`}>
                  {v === 'professional' ? 'Profissionais' : 'Cadeiras'}
                </button>
              ))}
            </div>
          )}
          {mode === 'week' && (
            <Select aria-label="Profissional" className="!h-8 !w-56" value={weekProf || weekProfs[0]?.id || ''} onChange={(e) => setWeekProf(e.target.value)}>
              {weekProfs.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </Select>
          )}
          {mode !== 'month' && (
            <span className="ml-auto">
              <Checkbox label={mode === 'day' ? `Mostrar canceladas e faltas (${counts.inactive})` : 'Mostrar canceladas e faltas'} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            </span>
          )}
        </div>

        {mode === 'day' && (
          <>
            {agenda.isLoading && <LoadingBlock rows={6} />}
            {agenda.error && <ErrorState error={agenda.error} onRetry={() => agenda.refetch()} />}
            {agenda.data && agenda.data.businessHours.length === 0 && agenda.data.appointments.length === 0 ? (
              <EmptyState icon={<CalendarDays className="size-5" aria-hidden />} title="Unidade fechada neste dia" description="Não há horário de funcionamento configurado para este dia da semana." />
            ) : (
              agenda.data && <DayView agenda={agenda.data} view={view} showInactive={showInactive} canWrite={can('schedule.write')} onSlot={setCreating} onOpen={setOpenId} onMove={setMove} />
            )}
          </>
        )}
        {mode === 'week' && unit && (
          <WeekView unitId={unit.id} from={weekFrom} professionalId={weekProf} showInactive={showInactive} canWrite={can('schedule.write')} onSlot={setCreating} onOpen={setOpenId} onMove={setMove} onProfessionals={setWeekProfs} />
        )}
        {mode === 'month' && unit && <MonthView unitId={unit.id} month={date} onPick={(d) => { setDate(d); setMode('day'); }} />}

        {can('schedule.write') && mode !== 'month' && (
          <p className="border-t border-border px-4 py-2 text-xs text-subtle">
            Clique em um horário livre para agendar. Arraste uma consulta para mover (pede confirmação). Faixas hachuradas: fora do funcionamento; tracejadas: bloqueios.
          </p>
        )}
      </Card>

      {agendaForDialogs && (
        <>
          <NewAppointmentDialog open={!!creating} onClose={() => setCreating(null)} agenda={agendaForDialogs} defaults={creating ?? { date, time: '09:00' }} />
          <AppointmentPanel id={openId} agenda={agendaForDialogs} onClose={() => setOpenId(null)} />
          <BlockDialog open={blocking} onClose={() => setBlocking(false)} agenda={agendaForDialogs} date={date} />
        </>
      )}

      <Dialog
        open={!!move}
        onClose={() => { setMove(null); setMoveError(null); }}
        title="Mover consulta?"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setMove(null); setMoveError(null); }}>Cancelar</Button>
            <Button loading={moving} onClick={confirmMove}>Mover</Button>
          </>
        }
      >
        {move && (
          <div className="space-y-3 text-sm">
            <FormError message={moveError} />
            <p>
              <strong>{move.appointment.patientSocialName || move.appointment.patientName}</strong>: de {fmtLongDay(zonedParts(new Date(move.appointment.startsAt), tz).date)} às {fmtTime(move.appointment.startsAt, tz)} para{' '}
              <strong>{fmtLongDay(move.date)} às {move.time}</strong>
              {move.professionalId !== move.appointment.professionalId && <> com <strong>{agenda.data?.professionals.find((p) => p.id === move.professionalId)?.displayName ?? weekProfs.find((p) => p.id === move.professionalId)?.displayName}</strong></>}.
            </p>
            {move.appointment.status === 'confirmed' && <p className="text-muted">A confirmação anterior deixará de valer. Avise o paciente sobre o novo horário.</p>}
            <p className="text-muted">
              Também é possível mover pelo botão <Link href="#" onClick={(e) => { e.preventDefault(); setOpenId(move.appointment.id); setMove(null); }} className="underline">Reagendar</Link> da consulta.
            </p>
          </div>
        )}
      </Dialog>
    </>
  );
}

export default function AgendaPage() { return <Suspense fallback={<LoadingBlock />}><AgendaContent /></Suspense>; }
