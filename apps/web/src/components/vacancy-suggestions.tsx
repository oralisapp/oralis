'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtPhone, fmtTime } from '@/lib/format';
import { useWaitlistSuggestions } from '@/lib/queries';
import { useOrg } from '@/lib/session';

/**
 * Candidatos da lista de espera para uma vaga. Mostra o critério de cada
 * sugestão; nada é reservado até a recepção clicar em "Agendar" — e a agenda
 * garante que a mesma vaga não seja dada a duas pessoas.
 */
export function VacancySuggestions({ unitId, professionalId, startsAt, endsAt, tz, onScheduled }: { unitId: string; professionalId: string; startsAt: string; endsAt: string; tz: string; onScheduled?: () => void }) {
  const { orgId, can } = useOrg();
  const headingId = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useWaitlistSuggestions({ unitId, professionalId, startsAt, endsAt });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function schedule(s: { entryId: string; patientId: string; patientName: string; durationMinutes: number; serviceId: string | null }) {
    if (!window.confirm(`Agendar ${s.patientName} às ${fmtTime(startsAt, tz)}?`)) return;
    setPending(s.entryId);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/appointments`, { unitId, patientId: s.patientId, professionalId, serviceId: s.serviceId ?? undefined, startsAt, durationMinutes: s.durationMinutes, waitlistEntryId: s.entryId });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({ tone: 'success', title: 'Paciente da lista de espera agendado', description: 'Lembre de avisar o paciente sobre o novo horário.' });
      onScheduled?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível agendar.');
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-accent/40 bg-accent-soft/40 p-4">
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold">
        <Sparkles className="size-4 text-accent" aria-hidden /> Vaga aberta · {fmtTime(startsAt, tz)}–{fmtTime(endsAt, tz)}
      </h3>
      <FormError message={error ?? (q.error ? 'Não foi possível consultar a lista de espera. Tente novamente.' : null)} />
      {q.isLoading && <p className="mt-2 text-sm text-muted">Procurando candidatos…</p>}
      {q.data && q.data.length === 0 && (
        <p className="mt-2 text-sm text-muted">
          <ListChecks className="mr-1 inline size-4" aria-hidden />
          Nenhum paciente da lista de espera é compatível com esta vaga (duração, dia, período e profissional).
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {q.data?.map((s) => (
          <li key={s.entryId} className="rounded-lg bg-surface p-3 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{s.patientName}</p>
                {s.patientPhone && <p className="text-xs text-muted">{fmtPhone(s.patientPhone)}</p>}
              </div>
              {can('schedule.write') && (
                <Button size="sm" disabled={pending !== null} loading={pending === s.entryId} onClick={() => schedule(s)}>
                  Agendar
                </Button>
              )}
            </div>
            <ul className="mt-2 list-disc pl-4 text-xs text-muted">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
