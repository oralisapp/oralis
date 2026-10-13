'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useOpenSlots } from '@/lib/queries';
import { fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { VacancySuggestions } from '@/components/vacancy-suggestions';

export function AgendaOpportunities({ unitId, date, tz }: { unitId: string; date: string; tz: string }) {
  const q = useOpenSlots(unitId, date);
  const [selected, setSelected] = useState('');
  const slots = q.data?.slots ?? [];
  const key = (s: typeof slots[number]) => `${s.professionalId}:${s.startsAt}`;
  const active = slots.find((s) => key(s) === selected);
  return <Card className="mb-5">
    <CardHeader title="Oportunidades para preencher o dia" description="Horários livres de 30 minutos ou mais. Encontre pacientes compatíveis na lista de espera." />
    {q.isLoading && <LoadingBlock rows={1} />}
    {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
    {q.data && <div className="px-5 pb-5">
      {!slots.length && <p className="text-sm text-muted">Nenhuma vaga disponível neste dia.</p>}
      <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
        {slots.map((s) => <Button key={key(s)} size="sm" variant={active === s ? 'soft' : 'secondary'} icon={<Sparkles className="size-3" aria-hidden />} onClick={() => setSelected(active === s ? '' : key(s))}>
          {fmtTime(s.startsAt, tz)} · {q.data.professionals.find((p) => p.id === s.professionalId)?.displayName} · {s.minutes} min
        </Button>)}
      </div>
      {active && <div className="mt-4"><VacancySuggestions key={key(active)} unitId={unitId} professionalId={active.professionalId} startsAt={active.startsAt} endsAt={active.endsAt} tz={tz} onScheduled={() => setSelected('')} /></div>}
    </div>}
  </Card>;
}
