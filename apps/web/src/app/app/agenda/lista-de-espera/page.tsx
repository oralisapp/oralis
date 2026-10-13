'use client';

import { todayInTz, WEEKDAY_LABEL } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ListChecks, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { PatientPicker } from '@/components/new-appointment-dialog';
import { VacancySuggestions } from '@/components/vacancy-suggestions';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtDuration, fmtPhone, fmtTime } from '@/lib/format';
import { useOpenSlots, useProfessionals, useServices, useWaitlist } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const PERIOD = { any: 'Qualquer período', morning: 'Manhã', afternoon: 'Tarde', evening: 'Noite' } as const;

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId, unit } = useOrg();
  const qc = useQueryClient();
  const profs = useProfessionals();
  const services = useServices();
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [f, setF] = useState({ professionalId: '', serviceId: '', durationMinutes: 30, weekdays: [] as number[], period: 'any', earliestDate: '', latestDate: '', priority: 0, notes: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPatient(null);
      setError(null);
      setF({ professionalId: '', serviceId: '', durationMinutes: 30, weekdays: [], period: 'any', earliestDate: '', latestDate: '', priority: 0, notes: '' });
    }
  }, [open]);
  const save = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/waitlist`, { ...f, patientId: patient?.id, unitId: unit?.id }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.'),
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Adicionar à lista de espera" description="Quando abrir uma vaga compatível, o paciente aparece como sugestão." footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button type="submit" form="wl-form" loading={save.isPending}>Adicionar</Button></>}>
      <form id="wl-form" noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!patient) { setError('Selecione o paciente.'); return; } save.mutate(); }}>
        <div className="sm:col-span-2"><FormError message={error} /></div>
        <div className="sm:col-span-2"><p className="mb-1.5 text-[13px] font-semibold">Paciente <span className="text-danger">*</span></p><PatientPicker value={patient} onChange={setPatient} /></div>
        <Field label="Profissional">{(p) => <Select {...p} value={f.professionalId} onChange={(e) => setF({ ...f, professionalId: e.target.value })}><option value="">Qualquer</option>{profs.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}</Field>
        <Field label="Serviço">
          {(p) => (
            <Select {...p} value={f.serviceId} onChange={(e) => { const s = services.data?.find((x) => x.id === e.target.value); setF({ ...f, serviceId: e.target.value, durationMinutes: s?.durationMinutes ?? f.durationMinutes }); }}>
              <option value="">Não definido</option>
              {services.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Duração (min)" required>{(p) => <Input {...p} type="number" min={5} step={5} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} />}</Field>
        <Field label="Período">{(p) => <Select {...p} value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>{Object.entries(PERIOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-semibold">Dias disponíveis <span className="font-normal text-subtle">(nenhum = qualquer dia)</span></legend>
          <div className="flex flex-wrap gap-3">{[1, 2, 3, 4, 5, 6, 0].map((d) => <Checkbox key={d} label={WEEKDAY_LABEL[d]!} checked={f.weekdays.includes(d)} onChange={(e) => setF({ ...f, weekdays: e.target.checked ? [...f.weekdays, d] : f.weekdays.filter((x) => x !== d) })} />)}</div>
        </fieldset>
        <Field label="A partir de">{(p) => <Input {...p} type="date" value={f.earliestDate} onChange={(e) => setF({ ...f, earliestDate: e.target.value })} />}</Field>
        <Field label="Até">{(p) => <Input {...p} type="date" value={f.latestDate} onChange={(e) => setF({ ...f, latestDate: e.target.value })} />}</Field>
        <Field label="Prioridade">{(p) => <Select {...p} value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}><option value={0}>Normal</option><option value={1}>Média</option><option value={2}>Alta</option></Select>}</Field>
        <Field label="Observação">{(p) => <Textarea {...p} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} />}</Field>
      </form>
    </Dialog>
  );
}

function OpenSlots() {
  const { unit } = useOrg();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const [date, setDate] = useState(() => todayInTz(tz));
  const q = useOpenSlots(unit?.id, date);
  const [selected, setSelected] = useState<string | null>(null);
  const profName = (id: string) => q.data?.professionals.find((p) => p.id === id)?.displayName ?? '';
  return (
    <Card>
      <CardHeader icon={<Sparkles className="size-5" aria-hidden />} title="Vagas abertas" description="Intervalos livres de 30 min ou mais, descontando consultas e bloqueios." actions={<input type="date" aria-label="Data" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-8 rounded-lg border border-border bg-surface px-2 text-sm" />} />
      {q.isLoading && <LoadingBlock rows={2} />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && q.data.slots.length === 0 && <p className="px-5 py-4 text-sm text-muted">Nenhuma vaga livre neste dia.</p>}
      <ul className="divide-y divide-border">
        {q.data?.slots.map((s) => {
          const key = `${s.professionalId}-${s.startsAt}`;
          return (
            <li key={key} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold tabular-nums">{fmtTime(s.startsAt, tz)}–{fmtTime(s.endsAt, tz)}</span>
                <span className="text-sm text-muted">{profName(s.professionalId)} · {fmtDuration(s.minutes)}</span>
                <Button size="sm" variant="soft" className="ml-auto" onClick={() => setSelected(selected === key ? null : key)}>{selected === key ? 'Fechar' : 'Ver candidatos'}</Button>
              </div>
              {selected === key && unit && <div className="mt-3"><VacancySuggestions unitId={unit.id} professionalId={s.professionalId} startsAt={s.startsAt} endsAt={s.endsAt} tz={tz} onScheduled={() => setSelected(null)} /></div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default function WaitlistPage() {
  const { can, orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useWaitlist();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/orgs/${orgId}/waitlist/${id}`),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Removido da lista de espera' });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
  });
  if (!can('schedule.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  return (
    <>
      <Link href="/app/agenda" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden /> Agenda</Link>
      <PageHeader title="Lista de espera" description="Pacientes que aceitam um horário antes. Ao surgir uma vaga, o sistema sugere quem é compatível — a decisão é sempre da recepção." actions={can('schedule.write') && <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Adicionar</Button>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader icon={<ListChecks className="size-5" aria-hidden />} title="Aguardando vaga" />
          {list.isLoading && <LoadingBlock />}
          {list.error && <ErrorState error={list.error} />}
          {list.data && list.data.length === 0 && <EmptyState icon={<ListChecks className="size-5" aria-hidden />} title="Lista vazia" description="Adicione pacientes que querem antecipar a consulta." />}
          <ul className="divide-y divide-border">
            {list.data?.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{e.patientName} {e.priority > 0 && <Badge tone={e.priority === 2 ? 'danger' : 'warning'}>{e.priority === 2 ? 'Prioridade alta' : 'Prioridade média'}</Badge>}</p>
                  <p className="text-sm text-muted">
                    {[fmtDuration(e.durationMinutes), e.serviceName, e.professionalName ?? 'qualquer profissional', e.weekdays.length ? e.weekdays.map((d) => WEEKDAY_LABEL[d]!.slice(0, 3)).join(', ') : 'qualquer dia', PERIOD[e.period]].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs text-subtle">
                    Desde {fmtCivilDate(e.createdAt.slice(0, 10))}{e.patientPhone ? ` · ${fmtPhone(e.patientPhone)}` : ''}{e.latestDate ? ` · até ${fmtCivilDate(e.latestDate)}` : ''}
                  </p>
                  {e.notes && <p className="mt-1 text-sm">{e.notes}</p>}
                </div>
                {can('schedule.write') && <Button size="sm" variant="ghost" onClick={() => remove.mutate(e.id)}>Remover</Button>}
              </li>
            ))}
          </ul>
        </Card>
        <OpenSlots />
      </div>
      <AddDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
