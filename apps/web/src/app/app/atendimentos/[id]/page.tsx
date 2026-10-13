'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCheck, History, Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { AlertChips, type AnamnesisState, AlertsPanel, AnamnesisPanel, type ClinicalAlert } from '@/components/clinical/clinical-panels';
import { type DraftRecord, RecordEditor } from '@/components/clinical/record-editor';
import { type ClinicalRecordView, RecordView } from '@/components/clinical/record-view';
import { DocumentsPanel } from '@/components/documents-panel';
import { Odontogram } from '@/components/clinical/odontogram';
import { PatientPlans } from '@/components/patient-plans';
import { StatusBadge } from '@/components/status-badge';
import { UnsavedGuard } from '@/components/clinical/unsaved-guard';
import { PaymentDialog } from '@/components/finance/payment-dialog';
import { Button, ButtonLink } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { FormError } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { ageFrom, fmtDate, fmtTime } from '@/lib/format';
import { useOrgQuery, useServices } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import type { AppointmentStatus } from '@oralis/shared';

export interface Workspace {
  appointment: { id: string; status: AppointmentStatus; startsAt: string; endsAt: string; version: number; unitId: string; unitName: string; timezone: string; professionalId: string; professionalName: string; serviceName: string | null; treatmentItemId: string | null; isOwn: boolean };
  patient: { id: string; fullName: string; socialName: string | null; birthDate: string | null };
  encounter: { id: string; startedAt: string; endedAt: string | null } | null;
  records: (ClinicalRecordView & DraftRecord & { authorUserId: string })[];
  othersDrafting: boolean;
  previous: ClinicalRecordView[];
  alerts: ClinicalAlert[];
  anamnesis: AnamnesisState;
  documents: { id: string; title: string; category: string; createdAt: string }[];
  treatmentItems: { id: string; description: string; tooth: number | null; status: string; stage: number; planId: string; planTitle: string }[];
  canWrite: boolean;
}

type Tab = 'evolucao' | 'odontograma' | 'anamnese' | 'documentos';

/** Ambiente focado no atendimento: cabeçalho, área principal e painel contextual. */
export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { orgId, can, me } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useOrgQuery<Workspace>(['workspace', id], `/appointments/${id}/workspace`, can('clinical.read'), false);
  const services = useServices();
  const [tab, setTab] = useState<Tab>('evolucao');
  const [paying, setPaying] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/appointments/${id}/transitions`, { to: 'completed', version: q.data!.appointment.version }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Atendimento concluído' });
      setCompleting(false);
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  if (!can('clinical.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  if (q.isLoading) return <Card><LoadingBlock rows={6} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;

  const w = q.data;
  const tz = w.appointment.timezone;
  const today = new Date().toISOString().slice(0, 10);
  const age = ageFrom(w.patient.birthDate, today);
  const drafts = w.records.filter((r) => r.status === 'draft');
  const finalized = w.records.filter((r) => r.status === 'finalized');
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'workspace', id] });

  const tabs: { key: Tab; label: string; badge?: ReactNode }[] = [
    { key: 'evolucao', label: 'Evolução', badge: drafts.length ? <span className="ml-1 rounded-full bg-warning-soft px-1.5 text-[11px] text-warning">rascunho</span> : null },
    { key: 'odontograma', label: 'Odontograma' },
    { key: 'anamnese', label: 'Anamnese', badge: w.anamnesis.pendingPatientResponse ? <span className="ml-1 size-2 rounded-full bg-warning" aria-label="pendente" /> : null },
    { key: 'documentos', label: 'Documentos' },
  ];

  return (
    <>
      <UnsavedGuard />
      <Link href="/app/visao-geral" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Voltar ao dia
      </Link>

      {/* Cabeçalho: paciente, consulta, alertas e status */}
      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-lg font-extrabold text-on-primary" aria-hidden>
            {(w.patient.socialName || w.patient.fullName).charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-tight">
                <Link href={`/app/pacientes/${w.patient.id}`} className="hover:underline">{w.patient.socialName || w.patient.fullName}</Link>
              </h1>
              {age !== null && <span className="text-sm text-muted">{age} anos</span>}
              <StatusBadge status={w.appointment.status} />
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              <Stethoscope className="size-4" aria-hidden /> {w.appointment.professionalName} · {fmtDate(w.appointment.startsAt, tz, { weekday: 'short', day: '2-digit', month: 'short' })} {fmtTime(w.appointment.startsAt, tz)}–{fmtTime(w.appointment.endsAt, tz)} · {w.appointment.unitName}
              {w.appointment.serviceName && <> · {w.appointment.serviceName}</>}
            </p>
            <div className="mt-3"><AlertChips alerts={w.alerts} /></div>
          </div>
          {w.appointment.status === 'in_progress' && (w.appointment.isOwn || can('schedule.attend_any')) && (
            <Button icon={<CheckCheck className="size-4" aria-hidden />} onClick={() => setCompleting(true)}>Concluir atendimento</Button>
          )}
        </div>
      </Card>

      {w.appointment.status === 'completed' && <Card className="mb-5 border-accent/30 bg-accent-soft p-5">
        <p className="text-xs font-bold uppercase tracking-wider text-accent-text">Atendimento concluído</p>
        <h2 className="mt-1 text-lg font-bold">Organize os próximos passos</h2>
        <p className="mt-1 text-sm text-muted">Confira cobranças e combine o retorno com o paciente.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {can('schedule.write') && <ButtonLink href={`/app/agenda?paciente=${w.patient.id}&novo=1&unidade=${w.appointment.unitId}`}>Agendar retorno</ButtonLink>}
          {can('finance.write') && <Button variant="secondary" onClick={() => setPaying(true)}>Registrar recebimento</Button>}
          {can('finance.read') && <ButtonLink variant="secondary" href={`/app/financeiro?aba=receber&paciente=${w.patient.id}`}>Conferir cobranças</ButtonLink>}
          <ButtonLink variant="ghost" href={`/app/pacientes/${w.patient.id}`}>Ver jornada do paciente</ButtonLink>
        </div>
      </Card>}
      {paying && <PaymentDialog open onClose={() => setPaying(false)} patient={{ id: w.patient.id, name: w.patient.fullName }} />}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Área principal */}
        <Card>
          <div role="tablist" aria-label="Seções do atendimento" className="flex gap-1 border-b border-border px-3">
            {tabs.map((t) => (
              <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`-mb-px flex items-center border-b-2 px-3 py-3 text-sm font-semibold ${tab === t.key ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-fg'}`}>
                {t.label}{t.badge}
              </button>
            ))}
          </div>
          <div className="p-5" role="tabpanel">
            {(
              <div className="space-y-5" hidden={tab !== 'evolucao'}>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary-text">Consulta atual</p>
                {w.othersDrafting && <Notice tone="info">Outro profissional tem um rascunho em andamento neste atendimento.</Notice>}
                {drafts.map((r) =>
                  w.canWrite ? (
                    <RecordEditor key={r.id} record={r} services={services.data?.filter((s) => s.active) ?? []} tz={tz} onFinalized={refresh} treatmentItems={w.treatmentItems} />
                  ) : (
                    <Notice key={r.id} tone="info">Rascunho em andamento.</Notice>
                  ),
                )}
                {finalized.map((r) => <RecordView key={r.id} record={r} canAmend={w.canWrite} />)}
                {!drafts.length && !finalized.length && (
                  <Notice tone="info">
                    {w.encounter ? 'Nenhum registro deste atendimento visível para você.' : 'O registro clínico começa quando o profissional inicia o atendimento.'}
                  </Notice>
                )}
              </div>
            )}
            {tab === 'odontograma' && <Odontogram patientId={w.patient.id} canWrite={w.canWrite} />}
            {tab === 'anamnese' && <AnamnesisPanel patientId={w.patient.id} state={w.anamnesis} canWrite={w.canWrite} tz={tz} />}
            {tab === 'documentos' && <DocumentsPanel patientId={w.patient.id} tz={tz} />}
          </div>
        </Card>

        {/* Painel contextual */}
        <aside className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-3 text-sm font-bold">Alertas clínicos</h2>
            <AlertsPanel patientId={w.patient.id} alerts={w.alerts} canWrite={w.canWrite} tz={tz} />
          </Card>
          {w.treatmentItems.length > 0 && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-bold">Etapas pendentes do plano</h2>
              <ul className="space-y-1 text-sm">
                {w.treatmentItems.map((i) => (
                  <li key={i.id}><Link href={`/app/tratamentos/${i.planId}`} className="hover:underline">{i.description}{i.tooth ? ` · dente ${i.tooth}` : ''}</Link> <span className="text-xs text-muted">· etapa {i.stage} · {i.status === 'scheduled' ? 'agendada' : 'a agendar'}</span></li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Vincule o procedimento à etapa na evolução: ao finalizar, a etapa é concluída.</p>
            </Card>
          )}
          {w.canWrite && <PatientPlans patientId={w.patient.id} />}
          <Card className="p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><History className="size-4 text-subtle" aria-hidden /> Registros anteriores</h2>
            <p className="mb-3 text-xs text-muted">Separados da consulta atual. Somente leitura.</p>
            <div className="space-y-3">
              {w.previous.length === 0 && <p className="text-sm text-muted">Primeiro atendimento registrado deste paciente.</p>}
              {w.previous.map((r) => <RecordView key={r.id} record={r} canAmend={false} compact />)}
            </div>
          </Card>
        </aside>
      </div>

      <Dialog
        open={completing}
        onClose={() => setCompleting(false)}
        title="Concluir atendimento?"
        footer={<><Button variant="ghost" onClick={() => setCompleting(false)}>Voltar</Button><Button loading={complete.isPending} onClick={() => complete.mutate()}>Concluir</Button></>}
      >
        <FormError message={error} />
        {drafts.some((d) => d.authorUserId === me.user.id) ? (
          <Notice tone="warning" title="Há evolução em rascunho">Ela continuará salva e aparecerá em “Evoluções pendentes de finalização” no seu painel. Recomendamos revisar e finalizar agora.</Notice>
        ) : (
          <p className="text-sm text-muted">O atendimento será registrado como concluído na agenda.</p>
        )}
      </Dialog>
    </>
  );
}
