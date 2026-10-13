import { Check } from 'lucide-react';
import type { TreatmentItem } from '@/lib/queries';

/**
 * Jornada do tratamento: etapas em ordem, com o que já foi feito, o que está
 * agendado e o que falta. Derivada só dos registros (etapas e consultas).
 */
export function TreatmentJourney({ items, tz, compact = false }: { items: TreatmentItem[]; tz: string; compact?: boolean }) {
  const active = items.filter((i) => i.status !== 'cancelled');
  const stages = [...new Set(active.map((i) => i.stage))].sort((a, b) => a - b);
  const done = active.filter((i) => i.status === 'done').length;
  const pct = active.length ? Math.round((done / active.length) * 100) : 0;
  const fmt = (iso: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso do tratamento">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm font-semibold tabular-nums">{done} de {active.length} etapas</span>
      </div>
      <ol className="relative space-y-4 border-l-2 border-border pl-6">
        {stages.map((s) => {
          const its = active.filter((i) => i.stage === s);
          const allDone = its.every((i) => i.status === 'done');
          return (
            <li key={s} className="relative">
              <span className={`absolute -left-[33px] flex size-6 items-center justify-center rounded-full border-2 text-xs font-bold ${allDone ? 'border-accent bg-accent text-white' : 'border-border-strong bg-surface text-muted'}`} aria-hidden>
                {allDone ? <Check className="size-3.5" /> : s}
              </span>
              <p className="text-sm font-bold">Etapa {s}{allDone ? ' · concluída' : ''}</p>
              <ul className="mt-1 space-y-1">
                {its.map((i) => {
                  const next = i.appointments.find((a) => ['scheduled', 'confirmed', 'arrived', 'in_progress'].includes(a.status) && new Date(a.startsAt) > new Date());
                  return (
                    <li key={i.id} className="text-sm">
                      <span className={i.status === 'done' ? 'text-muted' : ''}>{i.description}{i.tooth ? ` (dente ${i.tooth})` : ''}</span>
                      <span className="ml-2 text-xs text-muted">
                        {i.status === 'done' ? '✓ realizado' : next ? `próxima sessão ${fmt(next.startsAt)}` : i.status === 'scheduled' ? 'agendado' : compact ? 'a agendar' : 'ainda não agendado'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
