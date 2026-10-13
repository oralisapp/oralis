'use client';

import { type AppointmentStatus, todayInTz } from '@oralis/shared';
import { ArrowRight, ArrowUpRight, UserPlus, Users, Sparkles, AlarmClock, CalendarDays, CheckCircle2, Circle, Lock, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { RolePriorities } from '@/components/role-priorities';
import { AppointmentPanel } from '@/components/appointment-panel';
import { STATUS_STYLE, StatusBadge } from '@/components/status-badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox } from '@/components/ui/field';
import { fmtDuration, fmtLongDay, fmtTime, minutesBetween } from '@/lib/format';
import { type AgendaAppointment, useAgenda, useOnboarding, useTasks } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const LANES: { status: AppointmentStatus; title: string }[] = [
  { status: 'scheduled', title: 'Previsto' },
  { status: 'confirmed', title: 'Confirmado' },
  { status: 'arrived', title: 'Chegou' },
  { status: 'in_progress', title: 'Em atendimento' },
  { status: 'completed', title: 'Concluído' },
];

/** Atualiza o "agora" a cada minuto para tempos de espera e atrasos. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function greeting(now: Date, tz: string) {
  const h = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: tz }).format(now));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function Checklist() {
  const q = useOnboarding();
  if (q.isLoading) return <Card><LoadingBlock rows={2} /></Card>;
  if (q.error || !q.data) return null;
  const { steps, requiredDone, requiredTotal } = q.data;
  if (steps.every((s) => s.done || s.optional) && requiredDone === requiredTotal) return null;
  const pct = requiredTotal ? Math.round((requiredDone / requiredTotal) * 100) : 0;
  const doneKeys = new Set(steps.filter((s) => s.done).map((s) => s.key));

  return (
    <Card className="mb-6 overflow-hidden">
      <CardHeader
        icon={<Rocket className="size-5" aria-hidden />}
        title="Começar com o Oralis"
        description={`${requiredDone} de ${requiredTotal} etapas essenciais concluídas. Etapas opcionais podem ficar para depois.`}
      />
      <div className="px-5 pt-3" aria-hidden>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ol className="grid gap-px p-3 sm:grid-cols-2">
        {steps.map((s) => {
          const blockedBy = s.dependsOn.filter((d) => !doneKeys.has(d));
          return (
            <li key={s.key} className="flex items-start gap-3 rounded-xl p-3">
              {s.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-accent" aria-label="Concluída" /> : <Circle className="mt-0.5 size-5 shrink-0 text-border-strong" aria-label="Pendente" />}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${s.done ? 'text-muted line-through decoration-1' : ''}`}>
                  {s.title} {s.optional && <span className="ml-1 text-xs font-normal text-subtle">(opcional)</span>}
                </p>
                {!s.done && <p className="text-xs text-muted">{s.description}</p>}
                {!s.done && blockedBy.length > 0 && <p className="mt-1 text-xs text-subtle">Depende de etapas anteriores.</p>}
              </div>
              {!s.done &&
                (s.allowed ? (
                  <Link href={s.href} className="shrink-0 text-sm font-semibold text-primary-text hover:underline">
                    Fazer agora
                  </Link>
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-subtle" title="Seu papel não permite esta etapa">
                    <Lock className="size-3.5" aria-hidden /> Outro responsável
                  </span>
                ))}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function LaneCard({ a, tz, now, profName, onOpen }: { a: AgendaAppointment; tz: string; now: Date; profName: string; onOpen: () => void }) {
  const late = (a.status === 'scheduled' || a.status === 'confirmed') && minutesBetween(a.startsAt, now) >= 10 && new Date(a.startsAt) < now;
  const waiting = a.status === 'arrived' && a.arrivedAt ? minutesBetween(a.arrivedAt, now) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="animate-rise w-full rounded-xl border border-border bg-surface p-3.5 text-left shadow-card transition hover:-translate-y-0.5 hover:border-primary/50"
      style={{ borderLeft: `4px solid ${STATUS_STYLE[a.status].bar}` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold tabular-nums">{fmtTime(a.startsAt, tz)}</span>
        {late && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-danger">
            <AlarmClock className="size-3.5" aria-hidden /> Atrasada
          </span>
        )}
        {waiting !== null && <span className={`text-xs font-semibold ${waiting >= 15 ? 'text-danger' : 'text-warning'}`}>espera {fmtDuration(waiting)}</span>}
      </div>
      <p className="mt-0.5 truncate font-semibold">{a.patientSocialName || a.patientName}</p>
      <p className="truncate text-xs text-muted">
        {profName}
        {a.serviceName ? ` · ${a.serviceName}` : ''}
      </p>
    </button>
  );
}

function Priorities() {
  const tasks = useTasks();
  return <Card className="overflow-hidden">
    <CardHeader title="Na sua lista" description="Pequenos passos. Clínica em dia." actions={<Link href="/app/tarefas" aria-label="Ver todas as tarefas" className="rounded-lg p-2 text-muted hover:bg-surface-2"><ArrowUpRight className="size-4" aria-hidden /></Link>} />
    {tasks.isLoading && <LoadingBlock rows={2} />}
    {tasks.error && <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />}
    {tasks.data && (tasks.data.length ? <ul className="divide-y divide-border px-5">{tasks.data.slice(0, 3).map(t => <li key={t.id}><Link href="/app/tarefas" className="group flex items-start gap-3 py-4"><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border-strong group-hover:border-primary"><ArrowRight className="size-3 text-primary opacity-0 group-hover:opacity-100" aria-hidden /></span><span className="min-w-0"><span className="line-clamp-2 text-xs font-semibold leading-relaxed">{t.title}</span><span className="mt-1 block text-[10px] text-muted">{t.assigneeName ?? 'Sua equipe'}</span></span></Link></li>)}</ul> : <div className="px-5 py-7"><CheckCircle2 className="mb-3 size-6 text-accent" aria-hidden /><p className="text-sm font-semibold">Tudo em dia por aqui.</p><p className="mt-1 text-xs text-muted">Suas próximas tarefas aparecerão neste espaço.</p></div>)}
  </Card>;
}

function TodayFlow() {
  const { unit, membership } = useOrg();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const today = todayInTz(tz);
  const agenda = useAgenda(unit?.id, today);
  const now = useNow();
  const [onlyMine, setOnlyMine] = useState(!!membership.professionalId);
  const [openId, setOpenId] = useState<string | null>(null);
  const appts = useMemo(() => (agenda.data?.appointments ?? []).filter(a => !onlyMine || a.professionalId === membership.professionalId), [agenda.data, onlyMine, membership.professionalId]);
  if (!unit) return <Card><EmptyState icon={<CalendarDays className="size-5" aria-hidden />} title="Selecione uma unidade" description="O resumo do dia acompanha a unidade selecionada no topo." /></Card>;
  if (agenda.isLoading) return <Card><LoadingBlock rows={5} /></Card>;
  if (agenda.error) return <Card><ErrorState error={agenda.error} onRetry={() => agenda.refetch()} /></Card>;
  if (!agenda.data) return null;
  const profName = (id: string) => agenda.data?.professionals.find(p => p.id === id)?.displayName ?? '';
  const active = appts.filter(a => a.status !== 'cancelled' && a.status !== 'no_show');
  const waiting = appts.filter(a => a.status === 'arrived');
  const completed = appts.filter(a => a.status === 'completed');
  const late = appts.filter(a => (a.status === 'scheduled' || a.status === 'confirmed') && new Date(a.startsAt) < now && minutesBetween(a.startsAt, now) >= 10);
  const next = active.filter(a => a.status !== 'completed').sort((a,b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 4);
  const progress = active.length ? Math.round(completed.length / active.length * 100) : 0;

  return <>
    <div className="overview-grid mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4 xl:gap-4">
      {[
        { label: 'Consultas hoje', value: active.length, hint: 'Sua agenda do dia', icon: CalendarDays, color: 'text-primary-text', bg: 'bg-primary-soft' },
        { label: 'Na recepção', value: waiting.length, hint: 'Pacientes aguardando', icon: Users, color: 'text-warning', bg: 'bg-warning-soft' },
        { label: 'Concluídas', value: completed.length, hint: 'Cuidado que acontece', icon: CheckCircle2, color: 'text-accent-text', bg: 'bg-accent-soft' },
        { label: 'Precisam de atenção', value: late.length, hint: 'Atraso de 10 min ou mais', icon: AlarmClock, color: late.length ? 'text-danger' : 'text-muted', bg: late.length ? 'bg-danger-soft' : 'bg-surface-2' },
      ].map(k => <Card key={k.label} as="div" className="stat-card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-2"><p className="text-[11px] font-semibold text-muted">{k.label}</p><span className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${k.bg} ${k.color}`}><k.icon className="size-4" aria-hidden /></span></div>
        <p className={`text-[36px] font-semibold leading-none tracking-tight tabular-nums ${k.color}`}>{String(k.value).padStart(2, '0')}</p><p className="mt-3 text-[10px] text-muted">{k.hint}</p><span className="stat-mark text-primary" aria-hidden />
      </Card>)}
    </div>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-center gap-2 text-xs text-muted"><span className="size-1.5 rounded-full bg-accent" aria-hidden />{unit.name}<span className="text-border-strong">/</span>{fmtLongDay(today)}</p>
      {membership.professionalId && <Checkbox label="Somente meus pacientes" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />}
    </div>
    <div className="mb-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="overflow-hidden">
        <CardHeader title="Sua agenda, de perto" description="Os próximos cuidados começam aqui." actions={<ButtonLink href="/app/agenda" variant="ghost" size="sm" icon={<ArrowUpRight className="size-4" aria-hidden />}>Ver agenda</ButtonLink>} />
        {next.length ? <div>
          <div className="hidden grid-cols-[70px_1fr_140px_24px] gap-4 border-b border-border bg-surface-2/50 px-6 py-3 text-[9px] font-bold uppercase tracking-[.13em] text-muted sm:grid"><span>Horário</span><span>Paciente / atendimento</span><span>Situação</span><span /></div>
          <ul className="divide-y divide-border">{next.map((a, index) => <li key={a.id}><button onClick={() => setOpenId(a.id)} type="button" className="appointment-row grid w-full grid-cols-[52px_minmax(0,1fr)_20px] items-center gap-3 px-4 py-5 text-left sm:grid-cols-[70px_minmax(0,1fr)_140px_24px] sm:gap-4 sm:px-6">
            <span><span className="block text-sm font-bold tabular-nums">{fmtTime(a.startsAt, tz)}</span><span className="mt-1 block text-[10px] text-muted">{fmtDuration(minutesBetween(a.startsAt, new Date(a.endsAt)))}</span></span>
            <span className="flex min-w-0 items-center gap-3"><span className={`avatar-tile hidden size-10 text-xs sm:flex ${index % 2 ? '!bg-accent-soft !text-accent-text' : ''}`} aria-hidden>{(a.patientSocialName || a.patientName).split(' ').filter(Boolean).slice(0,2).map(n=>n[0]).join('')}</span><span className="min-w-0"><span className="block truncate text-sm font-bold">{a.patientSocialName || a.patientName}</span><span className="mt-1 block truncate text-[11px] text-muted">{a.serviceName || 'Consulta'} · {profName(a.professionalId)}</span><span className="mt-2 block sm:hidden"><StatusBadge status={a.status} /></span></span></span>
            <span className="hidden sm:block"><StatusBadge status={a.status} /></span><ArrowUpRight className="size-4 text-muted" aria-hidden />
          </button></li>)}</ul>
          <div className="flex items-center justify-between border-t border-border bg-surface-2/40 px-6 py-3 text-[11px] text-muted"><span>{active.length - completed.length} atendimento(s) por concluir</span><Link href="/app/agenda" className="font-semibold text-primary-text">Agenda completa →</Link></div>
        </div> : <EmptyState icon={<CalendarDays className="size-6" aria-hidden />} title={completed.length ? 'Um dia de cuidado, concluído.' : 'Espaço para novos sorrisos.'} description={completed.length ? 'Todos os atendimentos previstos foram concluídos. Consulte a agenda para planejar os próximos dias.' : 'Sua agenda está livre por enquanto. Organize os próximos atendimentos e acompanhe tudo por aqui.'} action={<ButtonLink href="/app/agenda" variant="soft">Abrir agenda <ArrowRight className="size-4" aria-hidden /></ButtonLink>} />}
      </Card>
      <div className="space-y-5">
        <section className="day-progress relative overflow-hidden rounded-2xl p-5" aria-label="Progresso dos atendimentos">
          <div className="flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.15em] text-[#c7d7c9]">O dia em movimento</span><Sparkles className="size-4 text-[#d7edaa]" aria-hidden /></div>
          <div className="my-5 flex items-end justify-between"><p className="font-display text-3xl">Cada cuidado<br />conta.</p><span className="text-3xl font-semibold tracking-tight text-[#d7edaa]">{progress}<span className="text-base">%</span></span></div>
          <div className="day-progress-track h-1.5 overflow-hidden rounded-full" role="progressbar" aria-label="Consultas concluídas" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className="h-full rounded-full bg-[#d7edaa] transition-all" style={{ width: `${progress}%` }} /></div>
          <p className="mt-3 text-[10px] text-[#c7d7c9]">{completed.length} de {active.length} consultas concluídas</p>
        </section>
        <Priorities />
      </div>
    </div>
    <Card className="overflow-hidden">
      <CardHeader title="Jornada do paciente" description="Da chegada ao próximo sorriso. Toque em um cartão para acompanhar." icon={<Users className="size-5" aria-hidden />} />
      <div className="overflow-x-auto p-4 sm:p-5"><div className="grid gap-3 md:min-w-[850px] md:grid-cols-5">{LANES.map(lane => {
        const items = appts.filter(a => a.status === lane.status);
        return <section key={lane.status} aria-label={`${lane.title}: ${items.length}`} className="flow-lane p-2.5"><header className="mb-3 flex items-center justify-between gap-1 px-1 pb-3"><span className="flex items-center gap-2 text-[11px] font-semibold"><span className="size-1.5 rounded-full" style={{ background: STATUS_STYLE[lane.status].bar }} aria-hidden />{lane.title}</span><span className="rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-bold text-muted">{items.length}</span></header><div className="space-y-2">{items.map(a => <LaneCard key={a.id} a={a} tz={tz} now={now} profName={profName(a.professionalId)} onOpen={() => setOpenId(a.id)} />)}{!items.length && <p className="py-5 text-center text-[10px] text-muted">Nenhum paciente nesta etapa</p>}</div></section>;
      })}</div></div>
    </Card>
    <AppointmentPanel id={openId} agenda={agenda.data} onClose={() => setOpenId(null)} />
  </>;
}

export default function OverviewPage() {
  const { me, membership, unit, can } = useOrg();
  const now = useNow();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  return <>
    <div className="mb-6 flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[.2em] text-muted">Seu espaço de cuidado</p><span className="hidden items-center gap-1.5 text-[11px] text-muted sm:flex"><CalendarDays className="size-3.5" aria-hidden />{fmtLongDay(todayInTz(tz))}</span></div>
    <section className="overview-hero mb-6 px-6 py-7 sm:px-8 sm:py-8">
      <div className="hero-art" aria-hidden><span /><span /><span /><span /></div>
      <div className="relative flex flex-wrap items-center justify-between gap-6">
        <div><p className="mb-2 text-[10px] font-bold uppercase tracking-[.18em] text-primary-text">{membership.organizationName}</p><h1 className="font-display text-[34px] leading-tight sm:text-[44px]">{greeting(now, tz)}, {me.user.name.split(' ')[0]}<span className="text-accent">.</span></h1><p className="mt-2 max-w-lg text-sm text-muted">Um novo dia para cuidar de quem confia em você.</p></div>
        <div className="flex flex-wrap gap-2">{can('patients.write') && <ButtonLink href="/app/pacientes?novo=1" variant="secondary" icon={<UserPlus className="size-4" aria-hidden />}>Novo paciente</ButtonLink>}{can('schedule.read') && <ButtonLink href="/app/agenda" icon={<CalendarDays className="size-4" aria-hidden />}>Minha agenda <ArrowUpRight className="size-4" aria-hidden /></ButtonLink>}</div>
      </div>
    </section>
    <Checklist />
    <RolePriorities />
    {can('schedule.read') ? <TodayFlow key={`${membership.organizationId}:${unit?.id}`} /> : <div className="grid gap-5 md:grid-cols-2"><Priorities /><Card className="p-6"><p className="font-display text-2xl">Tudo ao seu alcance.</p><p className="mt-2 text-sm text-muted">Acesse as áreas disponíveis para o seu perfil e organize suas prioridades.</p><div className="mt-5 flex flex-wrap gap-2">{can('finance.read') && <ButtonLink href="/app/financeiro">Abrir financeiro</ButtonLink>}{can('patients.read') && <ButtonLink href="/app/pacientes" variant="secondary">Ver pacientes</ButtonLink>}</div></Card></div>}
  </>;
}
