'use client';

import { type ScheduleConflictDetail, zonedToInstant } from '@oralis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Search, UserPlus, X } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtPhone, fmtTime } from '@/lib/format';
import { type Agenda, usePatients } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { PatientFormDialog } from './patient-form-dialog';

export interface NewAppointmentDefaults {
  date: string;
  time: string;
  professionalId?: string;
  chairId?: string;
  patient?: { id: string; name: string };
  serviceId?: string;
  durationMinutes?: number;
  treatmentItemId?: string;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Busca de paciente com criação rápida quando ele ainda não existe. */
export function PatientPicker({ value, onChange, error }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void; error?: string }) {
  const { can } = useOrg();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(q.trim());
  const list = usePatients(debounced);
  const listId = useId();

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary-soft px-3 py-2">
        <span className="font-semibold text-primary-text">{value.name}</span>
        <button type="button" onClick={() => onChange(null)} className="rounded p-1 text-primary-text hover:bg-surface" aria-label="Trocar paciente">
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input aria-label="Buscar paciente por nome, telefone ou CPF" aria-controls={listId} aria-invalid={error ? true : undefined} placeholder="Buscar por nome, telefone ou CPF" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" data-autofocus />
      </div>
      {error && <p className="text-xs font-medium text-danger">{error}</p>}
      <ul id={listId} className="max-h-48 overflow-y-auto rounded-lg border border-border" aria-label="Pacientes encontrados">
        {list.isLoading && <li className="px-3 py-2 text-sm text-muted">Buscando…</li>}
        {list.data?.items.slice(0, 8).map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onChange({ id: p.id, name: p.socialName || p.fullName })} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2">
              <span className="font-medium">{p.socialName || p.fullName}</span>
              <span className="text-xs text-muted">{p.phone ? fmtPhone(p.phone) : fmtCivilDate(p.birthDate)}</span>
            </button>
          </li>
        ))}
        {list.data && list.data.items.length === 0 && <li className="px-3 py-2 text-sm text-muted">Nenhum paciente encontrado.</li>}
      </ul>
      {can('patients.write') && (
        <Button size="sm" variant="soft" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
          Cadastrar novo paciente
        </Button>
      )}
      <PatientFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(id, name) => onChange({ id, name })} />
    </div>
  );
}

const CONFLICT_LABEL = { professional: 'Profissional ocupado', chair: 'Cadeira ocupada', patient: 'Paciente com outra consulta', block: 'Horário bloqueado' } as const;

export function NewAppointmentDialog({ open, onClose, agenda, defaults }: { open: boolean; onClose: () => void; agenda: Agenda; defaults: NewAppointmentDefaults }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState({ professionalId: '', serviceId: '', chairId: '', date: '', time: '', duration: 30, notes: '', repeat: '', count: 4 });
  const [occurrences, setOccurrences] = useState<{ startsAt: string; message: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflictDetail[]>([]);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPatient(defaults.patient ?? null);
    setErrors({});
    setError(null);
    setConflicts([]);
    setOccurrences([]);
    setForm({
      professionalId: defaults.professionalId ?? agenda.professionals[0]?.id ?? '',
      serviceId: defaults.serviceId ?? '',
      chairId: defaults.chairId ?? '',
      date: defaults.date,
      time: defaults.time,
      duration: defaults.durationMinutes ?? 30,
      notes: '',
      repeat: '',
      count: 4,
    });
  }, [open, defaults, agenda.professionals]);

  const tz = agenda.unit.timezone;

  async function submit(e: FormEvent | null, skipConflicts = false) {
    e?.preventDefault();
    if (!patient) {
      setErrors({ patientId: 'Selecione ou cadastre o paciente.' });
      return;
    }
    setPending(true);
    setError(null);
    setErrors({});
    setConflicts([]);
    setOccurrences([]);
    try {
      const r = await api.post<{ created: unknown[]; skipped: unknown[] }>(`/orgs/${orgId}/appointments`, {
        unitId: agenda.unit.id,
        patientId: patient.id,
        professionalId: form.professionalId,
        serviceId: form.serviceId,
        chairId: form.chairId,
        startsAt: zonedToInstant(form.date, form.time, tz).toISOString(),
        durationMinutes: Number(form.duration),
        notes: form.notes,
        repeat: form.repeat ? { frequency: form.repeat, count: Number(form.count) } : undefined,
        skipConflicts,
        treatmentItemId: defaults.treatmentItemId,
      });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      toast({
        tone: 'success',
        title: r.created.length > 1 ? `${r.created.length} consultas agendadas` : 'Consulta agendada',
        description: r.skipped.length ? `${r.skipped.length} ocorrência(s) com conflito não foram criadas.` : `${patient.name} · ${fmtCivilDate(form.date)} às ${form.time}`,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(err.message);
        if (err.code === 'schedule_conflict') {
          setConflicts((err.details as { conflicts?: ScheduleConflictDetail[] })?.conflicts ?? []);
          setOccurrences((err.details as { occurrences?: { startsAt: string; message: string }[] })?.occurrences ?? []);
        }
      } else setError('Não foi possível agendar.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Novo agendamento"
      description={`${agenda.unit.name} · horários no fuso da unidade`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" form="appointment-form" loading={pending}>
            Agendar
          </Button>
        </>
      }
    >
      <form id="appointment-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="space-y-2 sm:col-span-2">
          <FormError message={conflicts.length || occurrences.length ? null : error} />
          {occurrences.length > 0 && (
            <Notice tone="warning" title={error ?? 'Conflitos na recorrência'}>
              <ul className="mt-1 space-y-0.5">{occurrences.map((o) => <li key={o.startsAt}>{fmtCivilDate(o.startsAt.slice(0, 10))} {fmtTime(o.startsAt, tz)} — {o.message}</li>)}</ul>
              <Button size="sm" variant="secondary" className="mt-2" loading={pending} onClick={() => submit(null, true)}>Criar só as ocorrências livres</Button>
            </Notice>
          )}
          {conflicts.length > 0 && (
            <Notice tone="danger" title={error ?? 'Conflito de horário'}>
              <ul className="mt-1 space-y-0.5">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    {CONFLICT_LABEL[c.kind]}: {fmtTime(c.startsAt, tz)}–{fmtTime(c.endsAt, tz)}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-semibold">
            Paciente <span className="text-danger">*</span>
          </p>
          <PatientPicker value={patient} onChange={setPatient} error={errors.patientId} />
        </div>
        <Field label="Profissional" required error={errors.professionalId}>
          {(p) => (
            <Select {...p} value={form.professionalId} onChange={(e) => setForm({ ...form, professionalId: e.target.value })}>
              {agenda.professionals.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Serviço" error={errors.serviceId} hint="Preenche a duração automaticamente.">
          {(p) => (
            <Select
              {...p}
              value={form.serviceId}
              onChange={(e) => {
                const svc = agenda.services.find((s) => s.id === e.target.value);
                setForm({ ...form, serviceId: e.target.value, duration: svc?.durationMinutes ?? form.duration });
              }}
            >
              <option value="">Sem serviço definido</option>
              {agenda.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMinutes} min)
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-[1fr_110px_100px] gap-3 sm:col-span-2">
          <Field label="Data" required error={errors.startsAt}>
            {(p) => <Input {...p} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}
          </Field>
          <Field label="Início" required>
            {(p) => <Input {...p} type="time" step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />}
          </Field>
          <Field label="Minutos" required error={errors.durationMinutes}>
            {(p) => <Input {...p} type="number" min={5} max={480} step={5} value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })} />}
          </Field>
        </div>
        <Field label="Cadeira / sala" error={errors.chairId} hint={agenda.chairs.length ? 'Evita uso simultâneo do mesmo recurso.' : 'Nenhuma cadeira configurada nesta unidade.'}>
          {(p) => (
            <Select {...p} value={form.chairId} onChange={(e) => setForm({ ...form, chairId: e.target.value })} disabled={!agenda.chairs.length}>
              <option value="">Não definir</option>
              {agenda.chairs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Repetir">
            {(p) => (
              <Select {...p} value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
                <option value="">Não repetir</option>
                <option value="weekly">Toda semana</option>
                <option value="biweekly">A cada 2 semanas</option>
                <option value="monthly">Todo mês</option>
              </Select>
            )}
          </Field>
          {form.repeat && <Field label="Vezes" required>{(p) => <Input {...p} type="number" min={2} max={52} value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) })} />}</Field>}
        </div>
        <Field label="Observação administrativa" error={errors.notes}>
          {(p) => <Textarea {...p} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={500} placeholder="Ex.: prefere ser lembrado por telefone" />}
        </Field>
      </form>
    </Dialog>
  );
}
