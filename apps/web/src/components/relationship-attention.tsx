'use client';

import { todayInTz } from '@oralis/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/lib/session';
import { useAgendaRange, useTasks } from '@/lib/queries';
import { fmtDateTime } from '@/lib/format';
import { Card, CardHeader, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { ButtonLink } from '@/components/ui/button';

export function RelationshipAttention() {
  const { unit, can } = useOrg();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const today = todayInTz(tz);
  const until = new Date(`${today}T12:00:00Z`); until.setUTCDate(until.getUTCDate() + 6);
  const agenda = useAgendaRange(can('schedule.read') ? unit?.id : undefined, today, until.toISOString().slice(0, 10));
  const tasks = useTasks('all');
  const [filter, setFilter] = useState<'all' | 'late'>('all');
  const appointments = (agenda.data?.appointments ?? []).filter((a) => a.status === 'scheduled' && new Date(a.startsAt) > new Date());
  const followups = (tasks.data ?? []).filter((t) => (!t.unitId || t.unitId === unit?.id) && /retorno|acompanhamento|continuidade|contato|orçamento/i.test(t.title) && (filter !== 'late' || (t.dueAt && new Date(t.dueAt) < new Date())));
  return <div className="grid gap-5 lg:grid-cols-2">
    {can('schedule.read') && <Card>
      <CardHeader title={`${appointments.length} consultas aguardando confirmação`} description="Próximos sete dias, na unidade selecionada. Abra a consulta para revisar e compartilhar o pedido de confirmação." />
      {agenda.isLoading && <LoadingBlock />}{agenda.error && <ErrorState error={agenda.error} onRetry={() => agenda.refetch()} />}
      <ul className="divide-y divide-border">{appointments.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-semibold">{a.patientSocialName ?? a.patientName}</p><p className="text-xs text-muted">{fmtDateTime(a.startsAt, tz)}</p></div><ButtonLink size="sm" variant="secondary" href={`/app/agenda?data=${todayInTz(tz, new Date(a.startsAt))}&consulta=${a.id}&unidade=${a.unitId}`}>Abrir consulta</ButtonLink></li>)}</ul>
      {agenda.data && !appointments.length && <p className="p-5 text-sm text-muted">Nenhuma confirmação pendente nesse período.</p>}
    </Card>}
    <Card><CardHeader title="Retornos e acompanhamentos" description="Tarefas de contato e continuidade da equipe nesta unidade." actions={<select aria-label="Filtrar acompanhamentos" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'late')} className="rounded-lg border border-border bg-surface p-2 text-sm"><option value="all">Todos</option><option value="late">Atrasados</option></select>} />
      {tasks.isLoading && <LoadingBlock />}{tasks.error && <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />}
      <ul className="divide-y divide-border">{followups.map((t) => <li key={t.id} className="p-4"><p className="font-semibold">{t.title}</p><p className="mt-1 text-xs text-muted">{t.dueAt ? fmtDateTime(t.dueAt, tz) : 'Sem prazo'} · {t.assigneeName ?? 'Equipe'}</p>{t.relatedType === 'patient' && t.relatedId && can('patients.read') && <Link href={`/app/pacientes/${t.relatedId}`} className="mt-2 inline-block text-sm font-semibold text-primary-text">Abrir ficha →</Link>}</li>)}</ul>
      {tasks.data && !followups.length && <p className="p-5 text-sm text-muted">Nenhum acompanhamento neste filtro.</p>}
      <div className="border-t border-border p-4"><ButtonLink href="/app/tarefas" variant="secondary" size="sm">Organizar tarefas e retornos</ButtonLink></div>
    </Card>
  </div>;
}
