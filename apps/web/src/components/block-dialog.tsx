'use client';

import { zonedToInstant } from '@oralis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Field, FormError, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Agenda } from '@/lib/queries';
import { useOrg } from '@/lib/session';

/** Bloqueio de agenda: folga, férias, intervalo ou manutenção, com recorrência opcional. */
export function BlockDialog({ open, onClose, agenda, date }: { open: boolean; onClose: () => void; agenda: Pick<Agenda, 'unit' | 'professionals' | 'chairs'>; date: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = agenda.unit.timezone;
  const empty = { scope: 'professional', professionalId: '', chairId: '', kind: 'block', reason: '', startDate: date, startTime: '12:00', endDate: date, endTime: '13:00', repeat: '', count: 4 };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<{ startsAt: string; patientName: string }[] | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setF({ ...empty, professionalId: agenda.professionals[0]?.id ?? '', startDate: date, endDate: date });
      setError(null);
      setAffected(null);
    }
  }, [open, date]);

  async function save(acknowledge: boolean) {
    setPending(true);
    setError(null);
    try {
      const r = await api.post<{ ids: string[]; affectedAppointments: number }>(`/orgs/${orgId}/schedule-blocks`, {
        unitId: agenda.unit.id,
        professionalId: f.scope === 'professional' ? f.professionalId : undefined,
        chairId: f.scope === 'chair' ? f.chairId : undefined,
        kind: f.kind,
        reason: f.reason,
        startsAt: zonedToInstant(f.startDate, f.startTime, tz).toISOString(),
        endsAt: zonedToInstant(f.endDate, f.endTime, tz).toISOString(),
        repeat: f.repeat ? { frequency: f.repeat, count: Number(f.count) } : undefined,
        acknowledgeConflicts: acknowledge,
      });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({
        tone: 'success',
        title: r.ids.length > 1 ? `${r.ids.length} bloqueios criados` : 'Bloqueio criado',
        description: r.affectedAppointments ? `Uma tarefa foi criada para reagendar ${r.affectedAppointments} consulta(s).` : undefined,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'schedule_conflict' && (err.details as { affected?: unknown[] })?.affected) {
        setAffected((err.details as { affected: { startsAt: string; patientName: string }[] }).affected);
      } else setError(err instanceof ApiError ? err.message : 'Não foi possível bloquear.');
    } finally {
      setPending(false);
    }
  }

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bloquear horário"
      description={`${agenda.unit.name} · consultas não poderão ser marcadas no período`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          {affected ? (
            <Button variant="danger" loading={pending} onClick={() => save(true)}>Bloquear mesmo assim</Button>
          ) : (
            <Button type="submit" form="block-form" loading={pending}>Bloquear</Button>
          )}
        </>
      }
    >
      <form id="block-form" className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); void save(false); }}>
        <div className="sm:col-span-2 space-y-2">
          <FormError message={error} />
          {affected && (
            <Notice tone="warning" title={`${affected.length} consulta(s) já marcada(s) no período`}>
              <ul className="mt-1 list-disc pl-4">{affected.slice(0, 8).map((a, i) => <li key={i}>{a.patientName} — {fmtDateTime(a.startsAt, tz)}</li>)}</ul>
              <p className="mt-1">As consultas não serão canceladas. Será criada uma tarefa para a recepção reagendá-las.</p>
            </Notice>
          )}
        </div>
        <Field label="Tipo" required>
          {(p) => (
            <Select {...p} value={f.kind} onChange={set('kind')}>
              <option value="block">Bloqueio</option>
              <option value="vacation">Férias</option>
              <option value="break">Intervalo</option>
              <option value="maintenance">Manutenção</option>
            </Select>
          )}
        </Field>
        <Field label="Vale para" required>
          {(p) => (
            <Select {...p} value={f.scope} onChange={set('scope')}>
              <option value="professional">Um profissional</option>
              <option value="chair" disabled={!agenda.chairs.length}>Uma cadeira</option>
              <option value="unit">Toda a unidade</option>
            </Select>
          )}
        </Field>
        {f.scope === 'professional' && (
          <Field label="Profissional" required className="sm:col-span-2">
            {(p) => <Select {...p} value={f.professionalId} onChange={set('professionalId')}>{agenda.professionals.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}
          </Field>
        )}
        {f.scope === 'chair' && (
          <Field label="Cadeira" required className="sm:col-span-2">
            {(p) => <Select {...p} value={f.chairId} onChange={set('chairId')}><option value="">Selecione…</option>{agenda.chairs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
          </Field>
        )}
        <div className="grid grid-cols-[1fr_110px] gap-2">
          <Field label="Início" required>{(p) => <Input {...p} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
          <Field label="Hora" required>{(p) => <Input {...p} type="time" step={300} value={f.startTime} onChange={set('startTime')} />}</Field>
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-2">
          <Field label="Fim" required>{(p) => <Input {...p} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
          <Field label="Hora" required>{(p) => <Input {...p} type="time" step={300} value={f.endTime} onChange={set('endTime')} />}</Field>
        </div>
        <Field label="Motivo" className="sm:col-span-2" hint="Aparece na agenda para a equipe.">{(p) => <Input {...p} value={f.reason} onChange={set('reason')} maxLength={200} />}</Field>
        <Field label="Repetir">
          {(p) => (
            <Select {...p} value={f.repeat} onChange={set('repeat')}>
              <option value="">Não repetir</option>
              <option value="weekly">Toda semana</option>
              <option value="biweekly">A cada 2 semanas</option>
              <option value="monthly">Todo mês</option>
            </Select>
          )}
        </Field>
        {f.repeat && <Field label="Ocorrências" required>{(p) => <Input {...p} type="number" min={2} max={52} value={f.count} onChange={set('count')} />}</Field>}
      </form>
    </Dialog>
  );
}
