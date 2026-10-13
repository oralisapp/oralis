'use client';

import {
  APPOINTMENT_TRANSITIONS,
  type AppointmentStatus,
  CANCELLATION_REASONS,
  type CancellationReason,
  zonedParts,
  zonedToInstant,
} from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Clock, Copy, History, Link2, MapPin, Repeat, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime, fmtDuration, fmtLongDay, fmtPhone, fmtTime, minutesBetween } from '@/lib/format';
import { type Agenda, useAppointment } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { StatusBadge } from './status-badge';
import { VacancySuggestions } from './vacancy-suggestions';

type Mode = 'view' | 'cancel' | 'reschedule';

/**
 * Painel da consulta: dados, ações permitidas pela máquina de estados e pelo
 * papel do usuário, e o histórico imutável de alterações.
 */
export function AppointmentPanel({ id, agenda, onClose }: { id: string | null; agenda: Pick<Agenda, 'unit' | 'professionals' | 'chairs'>; onClose: () => void }) {
  const { orgId, can, membership } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useAppointment(id);
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('view');
  const [reason, setReason] = useState<CancellationReason | ''>('');
  const [note, setNote] = useState('');
  const [resched, setResched] = useState({ date: '', time: '', duration: 30, professionalId: '', chairId: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; emailDelivery: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMode('view');
    setReason('');
    setNote('');
    setFormError(null);
    setLink(null);
    setCopied(false);
  }, [id]);

  const tz = agenda.unit.timezone;
  const a = detail.data?.appointment;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['org', orgId] });
  };

  const onError = async (err: unknown) => {
    const msg = err instanceof ApiError ? err.message : 'Não foi possível concluir a ação.';
    if (err instanceof ApiError && err.code === 'stale_version') {
      toast({ tone: 'error', title: 'A consulta mudou', description: msg });
      await refresh();
    } else setFormError(msg);
  };

  const transition = useMutation({
    mutationFn: (to: AppointmentStatus) => api.post(`/orgs/${orgId}/appointments/${id}/transitions`, { to, version: a!.version, reason: to === 'cancelled' ? reason : undefined, note }),
    onSuccess: async (_r, to) => {
      toast({ tone: 'success', title: to === 'cancelled' ? 'Consulta cancelada' : 'Status atualizado' });
      if (to === 'in_progress' && can('clinical.read')) router.push(`/app/atendimentos/${id}`);
      setMode('view');
      setNote('');
      setFormError(null);
      await refresh();
    },
    onError,
  });

  const reschedule = useMutation({
    mutationFn: () =>
      api.put(`/orgs/${orgId}/appointments/${id}/schedule`, {
        professionalId: resched.professionalId,
        chairId: resched.chairId || null,
        startsAt: zonedToInstant(resched.date, resched.time, tz).toISOString(),
        durationMinutes: Number(resched.duration),
        version: a!.version,
      }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Consulta reagendada', description: 'A confirmação anterior deixou de valer.' });
      setMode('view');
      setFormError(null);
      await refresh();
    },
    onError,
  });

  const makeLink = useMutation({
    mutationFn: (sendEmail: boolean) => api.post<{ url: string; emailDelivery: string }>(`/orgs/${orgId}/appointments/${id}/confirmation-link`, { sendEmail }),
    onSuccess: (r) => setLink(r),
    onError,
  });

  function openReschedule() {
    if (!a) return;
    const p = zonedParts(new Date(a.startsAt), tz);
    setResched({
      date: p.date,
      time: fmtTime(a.startsAt, tz),
      duration: minutesBetween(a.startsAt, new Date(a.endsAt)),
      professionalId: a.professionalId,
      chairId: a.chairId ?? '',
    });
    setFormError(null);
    setMode('reschedule');
  }

  const professional = a ? agenda.professionals.find((p) => p.id === a.professionalId) : undefined;
  const chair = a?.chairId ? agenda.chairs.find((c) => c.id === a.chairId) : undefined;
  const isOwn = professional?.membershipId === membership.membershipId;
  const actions = a
    ? APPOINTMENT_TRANSITIONS[a.status].filter((t) => can(t.permission) && (t.permission !== 'schedule.attend' || isOwn || can('schedule.attend_any')))
    : [];
  const canReschedule = a && can('schedule.write') && (a.status === 'scheduled' || a.status === 'confirmed');
  const canLink = a && can('schedule.confirm') && a.status === 'scheduled' && new Date(a.startsAt) > new Date();
  const openSlot = a && a.status === 'cancelled' && new Date(a.startsAt) > new Date();
  const deliveryText: Record<string, string> = {
    sent: 'E-mail enviado ao paciente.',
    queued_retry: 'O e-mail falhou e será reenviado automaticamente.',
    logged_locally: 'E-mail não configurado neste ambiente: mensagem na caixa de saída local.',
    not_allowed: 'O paciente recusou avisos por e-mail. Envie o link por outro canal autorizado.',
    no_email: 'Paciente sem e-mail cadastrado. Copie o link e envie por outro canal.',
    not_requested: 'Copie o link e envie ao paciente.',
  };

  return (
    <Dialog open={!!id} onClose={onClose} side title="Consulta" description={a ? `${fmtLongDay(zonedParts(new Date(a.startsAt), tz).date)} · ${agenda.unit.name}` : undefined}>
      {detail.isLoading && <LoadingBlock rows={4} />}
      {detail.error && <ErrorState error={detail.error} onRetry={() => detail.refetch()} />}
      {a && (
        <div className="space-y-6">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Link href={`/app/pacientes/${a.patientId}`} className="text-lg font-bold hover:underline">
                  {a.patientSocialName || a.patientName}
                </Link>
                {a.patientPhone && <p className="text-sm text-muted">{fmtPhone(a.patientPhone)}</p>}
              </div>
              <StatusBadge status={a.status} />
            </div>
            <dl className="mt-4 grid gap-2 text-sm">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-subtle" aria-hidden />
                <dt className="sr-only">Horário</dt>
                <dd>
                  {fmtTime(a.startsAt, tz)}–{fmtTime(a.endsAt, tz)} ({fmtDuration(minutesBetween(a.startsAt, new Date(a.endsAt)))})
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <UserRound className="size-4 text-subtle" aria-hidden />
                <dt className="sr-only">Profissional</dt>
                <dd>{professional?.displayName ?? 'Profissional'}</dd>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="size-4 text-subtle" aria-hidden />
                <dt className="sr-only">Cadeira</dt>
                <dd>{chair ? chair.name : 'Sem cadeira definida'}</dd>
              </div>
              {a.serviceName && (
                <div className="flex items-center gap-2">
                  <CalendarClock className="size-4 text-subtle" aria-hidden />
                  <dt className="sr-only">Serviço</dt>
                  <dd>{a.serviceName}</dd>
                </div>
              )}
            </dl>
            {a.status === 'arrived' && a.arrivedAt && (
              <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm font-medium text-warning">Aguardando há {fmtDuration(minutesBetween(a.arrivedAt, new Date()))} desde o check-in.</p>
            )}
            {a.notes && <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">{a.notes}</p>}
            {a.seriesId && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <Repeat className="size-3.5" aria-hidden /> Faz parte de uma série recorrente.
              </p>
            )}
            {(a.status === 'in_progress' || a.status === 'completed') && can('clinical.read') && (
              <Link href={`/app/atendimentos/${a.id}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline">
                Abrir atendimento →
              </Link>
            )}
          </div>

          {canLink && (
            <div className="rounded-xl border border-border p-3">
              {!link ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 className="size-4 text-subtle" aria-hidden />
                  <span className="text-sm font-semibold">Confirmação pelo paciente</span>
                  <Button size="sm" variant="secondary" loading={makeLink.isPending && makeLink.variables === true} onClick={() => makeLink.mutate(true)}>Enviar por e-mail</Button>
                  <Button size="sm" variant="ghost" loading={makeLink.isPending && makeLink.variables === false} onClick={() => makeLink.mutate(false)}>Só gerar link</Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted">{deliveryText[link.emailDelivery] ?? ''} O link vale até o início da consulta e mostra só data, horário e local.</p>
                  <div className="flex gap-2">
                    <Input readOnly value={link.url} aria-label="Link de confirmação" onFocus={(e) => e.target.select()} />
                    <Button size="sm" variant="secondary" icon={copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} onClick={async () => { await navigator.clipboard.writeText(link.url).catch(() => {}); setCopied(true); }}>
                      {copied ? 'Copiado' : 'Copiar'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {openSlot && can('schedule.write') && (
            <VacancySuggestions unitId={agenda.unit.id} professionalId={a.professionalId} startsAt={a.startsAt} endsAt={a.endsAt} tz={tz} onScheduled={onClose} />
          )}

          {mode === 'view' && (actions.length > 0 || canReschedule) && (
            <div className="space-y-2">
              <FormError message={formError} />
              <div className="flex flex-wrap gap-2">
                {actions
                  .filter((t) => t.to !== 'cancelled')
                  .map((t, i) => (
                    <Button key={t.to} variant={i === 0 ? 'primary' : 'secondary'} size="sm" loading={transition.isPending && transition.variables === t.to} onClick={() => transition.mutate(t.to)}>
                      {t.action}
                    </Button>
                  ))}
                {canReschedule && (
                  <Button variant="secondary" size="sm" onClick={openReschedule}>
                    Reagendar
                  </Button>
                )}
                {actions.some((t) => t.to === 'cancelled') && (
                  <Button variant="ghost" size="sm" className="text-danger" onClick={() => setMode('cancel')}>
                    Cancelar consulta
                  </Button>
                )}
              </div>
            </div>
          )}

          {mode === 'cancel' && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <FormError message={formError} />
              <Field label="Motivo do cancelamento" required>
                {(p) => (
                  <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as CancellationReason)}>
                    <option value="">Selecione…</option>
                    {Object.entries(CANCELLATION_REASONS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Observação">
                {(p) => <Textarea {...p} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
                  Voltar
                </Button>
                <Button variant="danger" size="sm" disabled={!reason} loading={transition.isPending} onClick={() => transition.mutate('cancelled')}>
                  Confirmar cancelamento
                </Button>
              </div>
            </div>
          )}

          {mode === 'reschedule' && (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <FormError message={formError} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Data" required>
                  {(p) => <Input {...p} type="date" value={resched.date} onChange={(e) => setResched({ ...resched, date: e.target.value })} />}
                </Field>
                <Field label="Início" required>
                  {(p) => <Input {...p} type="time" step={300} value={resched.time} onChange={(e) => setResched({ ...resched, time: e.target.value })} />}
                </Field>
                <Field label="Profissional" required>
                  {(p) => (
                    <Select {...p} value={resched.professionalId} onChange={(e) => setResched({ ...resched, professionalId: e.target.value })}>
                      {agenda.professionals.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.displayName}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Minutos" required>
                  {(p) => <Input {...p} type="number" min={5} max={480} step={5} value={resched.duration} onChange={(e) => setResched({ ...resched, duration: Number(e.target.value) })} />}
                </Field>
                <Field label="Cadeira" className="col-span-2">
                  {(p) => (
                    <Select {...p} value={resched.chairId} onChange={(e) => setResched({ ...resched, chairId: e.target.value })}>
                      <option value="">Não definir</option>
                      {agenda.chairs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              {a.status === 'confirmed' && <p className="text-xs text-muted">A consulta voltará para “Agendado” e precisará de nova confirmação.</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
                  Voltar
                </Button>
                <Button size="sm" loading={reschedule.isPending} onClick={() => reschedule.mutate()}>
                  Salvar novo horário
                </Button>
              </div>
            </div>
          )}

          <section aria-labelledby="hist">
            <h3 id="hist" className="mb-3 flex items-center gap-2 text-sm font-bold">
              <History className="size-4 text-subtle" aria-hidden /> Histórico
            </h3>
            <ol className="relative space-y-4 border-l border-border pl-5">
              {detail.data!.history.map((h) => (
                <li key={h.id} className="relative">
                  <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-primary" aria-hidden />
                  <p className="text-sm">
                    {h.fromLabel ? (
                      <>
                        {h.fromLabel} → <strong>{h.toLabel}</strong>
                      </>
                    ) : (
                      <strong>Agendada</strong>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {h.changedByName} · {fmtDateTime(h.changedAt, tz)}
                  </p>
                  {(h.reasonLabel || h.note) && <p className="mt-0.5 text-xs text-muted">{[h.reasonLabel, h.note].filter(Boolean).join(' — ')}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  );
}
