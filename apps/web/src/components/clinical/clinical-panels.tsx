'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ClipboardCheck, Flag, Info, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Notice } from '@/components/ui/feedback';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';

export interface ClinicalAlert {
  id: string;
  kind: 'allergy' | 'medication' | 'condition' | 'other';
  description: string;
  severity: 'info' | 'attention' | 'critical';
  createdAt: string;
  createdByName: string;
}

const KIND = { allergy: 'Alergia', medication: 'Medicamento', condition: 'Condição', other: 'Outro' } as const;
const SEVERITY_ICON = { info: Info, attention: AlertTriangle, critical: AlertOctagon } as const;
const SEVERITY_LABEL = { info: 'Informativo', attention: 'Atenção', critical: 'Crítico' } as const;

/** Alertas em destaque no cabeçalho do atendimento (ícone + texto, não só cor). */
export function AlertChips({ alerts }: { alerts: ClinicalAlert[] }) {
  if (!alerts.length) return <span className="text-sm text-muted">Sem alertas clínicos registrados.</span>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Alertas clínicos">
      {alerts.map((a) => {
        const Icon = SEVERITY_ICON[a.severity];
        return (
          <li key={a.id} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${a.severity === 'critical' ? 'bg-danger-soft text-danger' : a.severity === 'attention' ? 'bg-warning-soft text-warning' : 'bg-info-soft text-info-text'}`}>
            <Icon className="size-3.5" aria-hidden />
            <span className="sr-only">{SEVERITY_LABEL[a.severity]}:</span>
            {KIND[a.kind]}: {a.description}
          </li>
        );
      })}
    </ul>
  );
}

export function AlertsPanel({ patientId, alerts, canWrite, tz }: { patientId: string; alerts: ClinicalAlert[]; canWrite: boolean; tz: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ kind: 'allergy', description: '', severity: 'attention' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const add = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/patients/${patientId}/clinical-alerts`, f),
    onSuccess: async () => { setAdding(false); setF({ kind: 'allergy', description: '', severity: 'attention' }); await refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/orgs/${orgId}/clinical-alerts/${id}/resolve`), onSuccess: refresh });
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.id} className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-sm">
            <div className="flex-1">
              <p className="font-semibold">{KIND[a.kind]} · <span className="font-normal">{a.description}</span></p>
              <p className="text-xs text-muted">{SEVERITY_LABEL[a.severity]} · {a.createdByName} · {fmtDateTime(a.createdAt, tz)}</p>
            </div>
            {canWrite && <Button size="sm" variant="ghost" onClick={() => resolve.mutate(a.id)}>Não se aplica mais</Button>}
          </li>
        ))}
        {!alerts.length && <li className="text-sm text-muted">Nenhum alerta ativo.</li>}
      </ul>
      {canWrite && !adding && <Button size="sm" variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Registrar alerta</Button>}
      {adding && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <FormError message={error} />
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Tipo" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Select aria-label="Gravidade" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{Object.entries(SEVERITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </div>
          <Input aria-label="Descrição" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Ex.: alergia a penicilina" />
          <div className="flex gap-2"><Button size="sm" loading={add.isPending} onClick={() => add.mutate()}>Salvar</Button><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancelar</Button></div>
        </div>
      )}
    </div>
  );
}

interface Question { id: string; label: string; type: 'yesno' | 'text' | 'choice'; options?: string[]; flagWhenYes?: boolean }
interface AnamnesisResponse { id: string; createdAt: string; source: string; recordedByName: string | null; template: { id: string; name: string; version: number; questions: Question[] }; answers: Record<string, string | boolean | null> }
export interface AnamnesisState { latest: AnamnesisResponse | null; pendingPatientResponse: AnamnesisResponse | null; historyCount: number }

function Answers({ r }: { r: AnamnesisResponse }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {r.template.questions.map((q) => {
        const v = r.answers[q.id];
        const flagged = q.flagWhenYes && v === true;
        return (
          <div key={q.id} className={`flex gap-3 py-2 ${flagged ? 'font-semibold' : ''}`}>
            <dt className="flex-1 text-muted">{q.label}</dt>
            <dd className="flex items-center gap-1">
              {flagged && <Flag className="size-3.5 text-warning" aria-label="Resposta sinalizada" />}
              {v === true ? 'Sim' : v === false ? 'Não' : v || '—'}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Anamnese: última resposta registrada, revisão das respostas enviadas pelo paciente e nova coleta. */
export function AnamnesisPanel({ patientId, state, canWrite, tz }: { patientId: string; state: AnamnesisState; canWrite: boolean; tz: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useOrgQuery<{ id: string; name: string; version: number; questions: Question[] }[]>(['anamnesis-templates'], '/anamnesis-templates', canWrite);
  const [filling, setFilling] = useState<{ templateId: string; reviewOfId?: string } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | boolean | null>>({});
  const [error, setError] = useState<string | null>(null);
  const tpl = templates.data?.find((t) => t.id === filling?.templateId) ?? (filling && state.pendingPatientResponse?.template.id === filling.templateId ? state.pendingPatientResponse.template : undefined);

  useEffect(() => {
    if (!filling) return;
    if (filling.reviewOfId && state.pendingPatientResponse) setAnswers({ ...state.pendingPatientResponse.answers });
    else if (state.latest && state.latest.template.id === filling.templateId) setAnswers({ ...state.latest.answers });
    else setAnswers({});
  }, [filling, state.latest, state.pendingPatientResponse]);

  const save = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/patients/${patientId}/anamnesis`, { templateId: filling!.templateId, answers, reviewOfId: filling!.reviewOfId }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Anamnese registrada' });
      setFilling(null);
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });

  if (filling && tpl) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold">{tpl.name} <span className="font-normal text-muted">· versão {tpl.version}</span></p>
        {filling.reviewOfId && <Notice tone="info">Respostas enviadas pelo paciente. Confira com ele e corrija o que for preciso antes de registrar.</Notice>}
        <FormError message={error} />
        <ul className="space-y-3">
          {tpl.questions.map((q) => (
            <li key={q.id}>
              {q.type === 'yesno' ? (
                <fieldset>
                  <legend className="text-sm">{q.label}</legend>
                  <div className="mt-1 flex gap-4 text-sm">
                    {[true, false].map((v) => (
                      <label key={String(v)} className="flex items-center gap-1.5"><input type="radio" name={q.id} checked={answers[q.id] === v} onChange={() => setAnswers({ ...answers, [q.id]: v })} className="accent-[var(--primary)]" />{v ? 'Sim' : 'Não'}</label>
                    ))}
                  </div>
                </fieldset>
              ) : q.type === 'choice' ? (
                <Field label={q.label}>{(p) => <Select {...p} value={(answers[q.id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value || null })}><option value="">—</option>{q.options?.map((o) => <option key={o}>{o}</option>)}</Select>}</Field>
              ) : (
                <Field label={q.label}>{(p) => <Textarea {...p} rows={2} value={(answers[q.id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value || null })} />}</Field>
              )}
            </li>
          ))}
        </ul>
        <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Registrar anamnese</Button><Button variant="ghost" onClick={() => setFilling(null)}>Cancelar</Button></div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.pendingPatientResponse && (
        <Notice tone="warning" icon={<ClipboardCheck className="size-5" aria-hidden />} title="Respostas enviadas pelo paciente aguardam revisão">
          Enviadas em {fmtDateTime(state.pendingPatientResponse.createdAt, tz)} pelo portal. Não entram no prontuário até a revisão profissional.
          {canWrite && <div className="mt-2"><Button size="sm" onClick={() => setFilling({ templateId: state.pendingPatientResponse!.template.id, reviewOfId: state.pendingPatientResponse!.id })}>Revisar respostas</Button></div>}
        </Notice>
      )}
      {state.latest ? (
        <div>
          <p className="mb-2 text-xs text-muted">
            {state.latest.template.name} (v{state.latest.template.version}) · registrada por {state.latest.recordedByName ?? '—'} em {fmtDateTime(state.latest.createdAt, tz)}
            {state.historyCount > 1 && <Badge>{state.historyCount} registros</Badge>}
          </p>
          <Answers r={state.latest} />
        </div>
      ) : (
        <p className="text-sm text-muted">Nenhuma anamnese registrada.</p>
      )}
      {canWrite && templates.data && (
        <div className="flex flex-wrap items-center gap-2">
          {templates.data.map((t) => <Button key={t.id} size="sm" variant="secondary" onClick={() => setFilling({ templateId: t.id })}>{state.latest ? 'Atualizar' : 'Preencher'}: {t.name}</Button>)}
        </div>
      )}
    </div>
  );
}
