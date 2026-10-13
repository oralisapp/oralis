'use client';

import { AlertTriangle, Route } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { type ContinuityPlan, useContinuity } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const COLUMNS: { stage: ContinuityPlan['stage']; title: string; hint: string }[] = [
  { stage: 'evaluation', title: 'Em elaboração', hint: 'Plano montado, ainda não apresentado' },
  { stage: 'presented', title: 'Plano apresentado', hint: 'Aguardando decisão do paciente' },
  { stage: 'approved', title: 'Aprovado', hint: 'Sem sessão agendada' },
  { stage: 'scheduled', title: 'Agendado', hint: 'Primeira sessão marcada' },
  { stage: 'in_progress', title: 'Em andamento', hint: 'Ao menos uma etapa realizada' },
  { stage: 'completed', title: 'Concluído', hint: 'Todas as etapas realizadas' },
];

const PENDING_LABEL: Record<string, string> = {
  approved_without_session: 'Aprovado sem primeira sessão',
  no_next_session: 'Sem próxima sessão',
  quote_no_contact: 'Orçamento sem retorno ≥ 7 dias',
};

/** Mapa de continuidade do cuidado: onde cada tratamento está e o que precisa de ação. */
export default function ContinuityPage() {
  const { can, unit } = useOrg();
  const q = useContinuity();
  const [filter, setFilter] = useState<string | null>(null);
  if (!can('treatments.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const plans = (q.data?.plans ?? []).filter((p) => !filter || p.pending.some((x) => x.code === filter));

  return (
    <>
      <PageHeader
        title="Tratamentos"
        description="Mapa de continuidade do cuidado. As pendências vêm de registros explícitos (planos, orçamentos e agenda) — o sistema não faz inferências clínicas."
      />
      {q.data && Object.keys(q.data.counts).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por pendência">
          <button type="button" onClick={() => setFilter(null)} className={`rounded-full px-3 py-1 text-sm font-semibold ${!filter ? 'bg-primary text-on-primary' : 'bg-surface-2 text-muted'}`}>Todos</button>
          {Object.entries(q.data.counts).map(([code, n]) => (
            <button key={code} type="button" aria-pressed={filter === code} onClick={() => setFilter(filter === code ? null : code)} className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold ${filter === code ? 'bg-warning text-white' : 'bg-warning-soft text-warning'}`}>
              <AlertTriangle className="size-3.5" aria-hidden /> {PENDING_LABEL[code] ?? code}: {n}
            </button>
          ))}
        </div>
      )}
      {q.isLoading && <Card><LoadingBlock rows={6} /></Card>}
      {q.error && <Card><ErrorState error={q.error} /></Card>}
      {q.data && q.data.plans.length === 0 && (
        <Card><EmptyState icon={<Route className="size-5" aria-hidden />} title="Nenhum plano de tratamento" description="Planos são criados na ficha do paciente ou durante o atendimento." /></Card>
      )}
      {q.data && q.data.plans.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[1100px] grid-cols-6 gap-3">
            {COLUMNS.map((col) => {
              const items = plans.filter((p) => p.stage === col.stage);
              return (
                <section key={col.stage} aria-label={`${col.title}: ${items.length}`} className="rounded-xl bg-surface-2 p-2">
                  <header className="mb-2 px-1">
                    <p className="flex items-center justify-between text-sm font-bold">{col.title}<span className="text-xs text-muted tabular-nums">{items.length}</span></p>
                    <p className="text-[11px] text-subtle">{col.hint}</p>
                  </header>
                  <div className="space-y-2">
                    {items.map((p) => (
                      <Link key={p.id} href={`/app/tratamentos/${p.id}`} className="block rounded-xl border border-border bg-surface p-3 shadow-card transition hover:border-primary/50">
                        <p className="truncate text-sm font-semibold">{p.patientName}</p>
                        <p className="truncate text-xs text-muted">{p.title}{p.responsibleName ? ` · ${p.responsibleName}` : ''}</p>
                        {p.progress.total > 0 && (
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                            <div className="h-full bg-accent" style={{ width: `${(p.progress.done / p.progress.total) * 100}%` }} />
                          </div>
                        )}
                        {p.nextSessionAt && <p className="mt-1 text-[11px] text-muted">Próxima: {fmtDateTime(p.nextSessionAt, tz)}</p>}
                        {p.pending.map((x) => <span key={x.code} className="mt-1.5 block"><Badge tone="warning" icon={<AlertTriangle className="size-3" aria-hidden />}>{x.label}</Badge></span>)}
                      </Link>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
