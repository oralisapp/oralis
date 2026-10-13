'use client';

import { TREATMENT_ITEM_STATUS_LABEL, TREATMENT_PLAN_STATUS_LABEL, todayInTz } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, CheckCircle2, Eye, Pencil, Plus, Presentation, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NewAppointmentDialog, type NewAppointmentDefaults } from '@/components/new-appointment-dialog';
import { TreatmentJourney } from '@/components/treatment-journey';
import { Button, ButtonLink } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtCivilDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { type PlanDetail, type TreatmentItem, useAgenda, usePlan, useProfessionals, useServices } from '@/lib/queries';
import { useOrg } from '@/lib/session';

const STATUS_TONE: Record<PlanDetail['plan']['status'], 'neutral' | 'primary' | 'accent' | 'warning' | 'danger' | 'info'> = {
  draft: 'neutral', presented: 'info', approved: 'primary', rejected: 'danger', in_progress: 'warning', completed: 'accent', cancelled: 'neutral',
};
const METHOD = { to_define: 'A definir', pix: 'PIX', card_credit: 'Cartão de crédito', card_debit: 'Cartão de débito', cash: 'Dinheiro', boleto: 'Boleto', transfer: 'Transferência' } as const;

function ItemDialog({ planId, item, items, open, onClose }: { planId: string; item: TreatmentItem | null; items: TreatmentItem[]; open: boolean; onClose: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const services = useServices();
  const profs = useProfessionals();
  const empty = { description: '', serviceId: '', tooth: '', surfaces: [] as string[], stage: 1, priority: 'normal', professionalId: '', dependsOnItemId: '', sessionsPlanned: 1, unitPrice: '0.00' };
  const [f, setF] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setF(item ? { description: item.description, serviceId: item.serviceId ?? '', tooth: item.tooth ? String(item.tooth) : '', surfaces: item.surfaces, stage: item.stage, priority: item.priority, professionalId: item.professionalId ?? '', dependsOnItemId: item.dependsOnItemId ?? '', sessionsPlanned: item.sessionsPlanned, unitPrice: item.unitPrice } : { ...empty, stage: Math.max(1, ...items.map((i) => i.stage)) });
  }, [open, item]);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        description: f.description,
        serviceId: f.serviceId || undefined,
        tooth: f.tooth ? Number(f.tooth) : undefined,
        surfaces: f.surfaces,
        stage: Number(f.stage),
        priority: f.priority,
        professionalId: f.professionalId || undefined,
        dependsOnItemId: f.dependsOnItemId || undefined,
        sessionsPlanned: Number(f.sessionsPlanned),
        unitPrice: f.unitPrice.includes(',') ? f.unitPrice.replace(/\./g, '').replace(',', '.') : f.unitPrice,
      };
      return item ? api.put(`/orgs/${orgId}/treatment-items/${item.id}`, body) : api.post(`/orgs/${orgId}/treatment-plans/${planId}/items`, body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(Object.keys(err.fieldErrors).length ? null : err.message);
      }
    },
  });
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={item ? 'Editar etapa' : 'Nova etapa do tratamento'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Salvar</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormError message={error} /></div>
        <Field label="Serviço">
          {(p) => (
            <Select {...p} value={f.serviceId} onChange={(e) => { const s = services.data?.find((x) => x.id === e.target.value); setF({ ...f, serviceId: e.target.value, description: s?.name ?? f.description, unitPrice: s?.price ?? f.unitPrice }); }}>
              <option value="">Personalizado</option>
              {services.data?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Descrição" required error={errors.description}>{(p) => <Input {...p} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Dente (FDI)" error={errors.tooth} hint="Deixe vazio para procedimento geral.">{(p) => <Input {...p} inputMode="numeric" value={f.tooth} onChange={(e) => setF({ ...f, tooth: e.target.value })} />}</Field>
        <Field label="Valor (R$)" required error={errors.unitPrice}>{(p) => <Input {...p} inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} />}</Field>
        <Field label="Etapa (ordem)" required>{(p) => <Input {...p} type="number" min={1} max={20} value={f.stage} onChange={(e) => setF({ ...f, stage: Number(e.target.value) })} />}</Field>
        <Field label="Sessões previstas" required>{(p) => <Input {...p} type="number" min={1} max={50} value={f.sessionsPlanned} onChange={(e) => setF({ ...f, sessionsPlanned: Number(e.target.value) })} />}</Field>
        <Field label="Prioridade">{(p) => <Select {...p} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option></Select>}</Field>
        <Field label="Profissional">{(p) => <Select {...p} value={f.professionalId} onChange={(e) => setF({ ...f, professionalId: e.target.value })}><option value="">Responsável pelo plano</option>{profs.data?.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</Select>}</Field>
        <Field label="Depende de" className="sm:col-span-2" hint="Registro informativo definido pelo profissional.">
          {(p) => <Select {...p} value={f.dependsOnItemId} onChange={(e) => setF({ ...f, dependsOnItemId: e.target.value })}><option value="">Nenhuma etapa</option>{items.filter((i) => i.id !== item?.id && i.status !== 'cancelled').map((i) => <option key={i.id} value={i.id}>{i.description}{i.tooth ? ` (${i.tooth})` : ''}</option>)}</Select>}
        </Field>
      </div>
    </Dialog>
  );
}

function PresentDialog({ planId, total, open, onClose }: { planId: string; total: string; open: boolean; onClose: () => void }) {
  const { orgId, unit, can } = useOrg();
  const qc = useQueryClient();
  const tz = unit?.timezone ?? 'America/Sao_Paulo';
  const today = todayInTz(tz);
  const plus = (d: number) => new Date(Date.parse(`${today}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ discount: '0.00', discountReason: '', installments: 1, method: 'to_define', firstDueDate: plus(7), validUntil: plus(30) });
  const [error, setError] = useState<string | null>(null);
  const present = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/treatment-plans/${planId}/present`, { ...f, discount: f.discount.includes(',') ? f.discount.replace(/\./g, '').replace(',', '.') : f.discount }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['org', orgId] }); onClose(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Apresentar orçamento" description={`Total das etapas: ${fmtMoney(total)}. Uma versão imutável será registrada.`} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={present.isPending} onClick={() => present.mutate()}>Registrar e apresentar</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormError message={error} /></div>
        <Field label="Desconto (R$)" hint={can('quotes.discount') ? undefined : 'Acima de 10% precisa de gestor.'}>{(p) => <Input {...p} inputMode="decimal" value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} />}</Field>
        <Field label="Motivo do desconto">{(p) => <Input {...p} value={f.discountReason} onChange={(e) => setF({ ...f, discountReason: e.target.value })} />}</Field>
        <Field label="Parcelas" required>{(p) => <Input {...p} type="number" min={1} max={24} value={f.installments} onChange={(e) => setF({ ...f, installments: Number(e.target.value) })} />}</Field>
        <Field label="Forma de pagamento">{(p) => <Select {...p} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="1º vencimento" required>{(p) => <Input {...p} type="date" value={f.firstDueDate} onChange={(e) => setF({ ...f, firstDueDate: e.target.value })} />}</Field>
        <Field label="Válido até" required>{(p) => <Input {...p} type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />}</Field>
      </div>
    </Dialog>
  );
}

function DecisionDialog({ quote, version, decision, onClose }: { quote: PlanDetail['quotes'][number]; version: PlanDetail['quotes'][number]['versions'][number]; decision: 'approved' | 'rejected' | null; onClose: () => void }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ reason: '', acknowledgedName: '', generateReceivables: true, createSchedulingTasks: true });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/quotes/${quote.id}/decision`, { versionId: version.id, decision, ...f, reason: f.reason || undefined, acknowledgedName: f.acknowledgedName || undefined }),
    onSuccess: async () => {
      toast({ tone: 'success', title: decision === 'approved' ? 'Aprovação registrada' : 'Recusa registrada' });
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro'),
  });
  return (
    <Dialog open={!!decision} onClose={onClose} title={decision === 'approved' ? `Registrar aprovação da versão ${version.version}` : 'Registrar recusa'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant={decision === 'rejected' ? 'danger' : 'primary'} loading={save.isPending} onClick={() => save.mutate()}>Confirmar</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        {decision === 'approved' ? (
          <>
            <Notice tone="info">A aprovação comercial não substitui o termo de consentimento clínico e não registra nenhum procedimento como realizado.</Notice>
            <p className="text-sm">Valor aprovado: <strong>{fmtMoney(version.total)}</strong> em {version.paymentTerms.installments}x.</p>
            <Field label="Nome de quem aprovou">{(p) => <Input {...p} value={f.acknowledgedName} onChange={(e) => setF({ ...f, acknowledgedName: e.target.value })} placeholder="Paciente ou responsável" />}</Field>
            <Checkbox label="Gerar parcelas no financeiro" description={can('finance.write') ? 'Cria as contas a receber conforme as condições apresentadas.' : 'O financeiro poderá gerar depois.'} checked={f.generateReceivables} onChange={(e) => setF({ ...f, generateReceivables: e.target.checked })} />
            <Checkbox label="Criar tarefas para agendar as primeiras etapas" checked={f.createSchedulingTasks} onChange={(e) => setF({ ...f, createSchedulingTasks: e.target.checked })} />
          </>
        ) : (
          <Field label="Motivo da recusa" required>{(p) => <Textarea {...p} rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Ex.: preferiu pensar; valor; vai fazer em outro momento" />}</Field>
        )}
      </div>
    </Dialog>
  );
}

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const q = usePlan(id);
  const [editing, setEditing] = useState<TreatmentItem | null | 'new'>(null);
  const [presenting, setPresenting] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [scheduling, setScheduling] = useState<NewAppointmentDefaults | null>(null);
  const [planEdit, setPlanEdit] = useState<{ title: string; objective: string } | null>(null);
  const plan = q.data?.plan;
  const tz = plan?.timezone ?? 'America/Sao_Paulo';
  const agenda = useAgenda(plan?.unitId, todayInTz(tz));
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId] });
  const removeItem = useMutation({ mutationFn: (itemId: string) => api.delete(`/orgs/${orgId}/treatment-items/${itemId}`), onSuccess: refresh });
  const share = useMutation({ mutationFn: (v: boolean) => api.put(`/orgs/${orgId}/treatment-plans/${id}`, { sharedWithPatient: v }), onSuccess: refresh });
  const savePlan = useMutation({ mutationFn: () => api.put(`/orgs/${orgId}/treatment-plans/${id}`, planEdit), onSuccess: async () => { setPlanEdit(null); await refresh(); } });

  if (!can('treatments.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  if (q.isLoading) return <Card><LoadingBlock rows={6} /></Card>;
  if (q.error || !q.data || !plan) return <Card><ErrorState error={q.error} /></Card>;

  const { items, quotes } = q.data;
  const quote = quotes[0];
  const current = quote?.versions.find((v) => v.id === quote.currentVersionId);
  const editable = can('treatments.write') && !['completed', 'cancelled'].includes(plan.status);
  const schedulable = ['approved', 'in_progress'].includes(plan.status) && can('schedule.write');

  return (
    <>
      <Link href="/app/tratamentos" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden /> Tratamentos</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-primary-text"><Link href={`/app/pacientes/${plan.patientId}`} className="hover:underline">{plan.patientName}</Link></p>
          <h1 className="text-2xl font-extrabold tracking-tight">{plan.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={STATUS_TONE[plan.status]}>{TREATMENT_PLAN_STATUS_LABEL[plan.status]}</Badge>
            {plan.responsibleName && <span>Responsável: {plan.responsibleName}</span>}
            <span>· {plan.unitName}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/app/tratamentos/${id}/apresentacao`} variant="secondary" icon={<Presentation className="size-4" aria-hidden />}>Modo apresentação</ButtonLink>
          {can('quotes.present') && ['draft', 'presented', 'rejected'].includes(plan.status) && items.some((i) => i.status !== 'cancelled') && (
            <Button onClick={() => setPresenting(true)}>{plan.status === 'draft' && !quote ? 'Apresentar orçamento' : 'Registrar nova versão'}</Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Objetivo" description="Texto revisável pelo profissional, exibido ao paciente." actions={editable && !planEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setPlanEdit({ title: plan.title, objective: plan.objective ?? '' })}>Editar</Button>} />
            <div className="p-5">
              {planEdit ? (
                <div className="space-y-3">
                  <Input aria-label="Título" value={planEdit.title} onChange={(e) => setPlanEdit({ ...planEdit, title: e.target.value })} />
                  <Textarea aria-label="Objetivo" rows={4} value={planEdit.objective} onChange={(e) => setPlanEdit({ ...planEdit, objective: e.target.value })} />
                  <div className="flex gap-2"><Button size="sm" loading={savePlan.isPending} onClick={() => savePlan.mutate()}>Salvar</Button><Button size="sm" variant="ghost" onClick={() => setPlanEdit(null)}>Cancelar</Button></div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm">{plan.objective || <span className="text-muted">Sem objetivo descrito.</span>}</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Etapas e procedimentos" description={`Total: ${fmtMoney(q.data.totals.itemsTotal)}`} actions={editable && <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing('new')}>Etapa</Button>} />
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <li key={i.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${i.status === 'cancelled' ? 'opacity-50' : ''}`}>
                  <span className="flex size-7 items-center justify-center rounded-full bg-surface-2 text-xs font-bold" aria-label={`Etapa ${i.stage}`}>{i.stage}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{i.description}{i.tooth ? <span className="font-normal text-muted"> · dente {i.tooth}{i.surfaces.length ? ` (${i.surfaces.join('')})` : ''}</span> : null}</p>
                    <p className="text-xs text-muted">
                      {TREATMENT_ITEM_STATUS_LABEL[i.status]} · {i.sessionsPlanned} sessão(ões) · {fmtMoney(i.unitPrice)}{i.professionalName ? ` · ${i.professionalName}` : ''}
                      {i.dependsOnItemId ? ` · depois de: ${items.find((x) => x.id === i.dependsOnItemId)?.description ?? '—'}` : ''}
                    </p>
                  </div>
                  {schedulable && (i.status === 'planned' || i.status === 'scheduled') && agenda.data && (
                    <Button size="sm" variant="soft" icon={<CalendarPlus className="size-4" aria-hidden />} onClick={() => setScheduling({ date: todayInTz(tz), time: '09:00', professionalId: i.professionalId ?? plan.responsibleProfessionalId ?? undefined, patient: { id: plan.patientId, name: plan.patientName }, serviceId: i.serviceId ?? undefined, treatmentItemId: i.id })}>Agendar</Button>
                  )}
                  {editable && i.status === 'planned' && (
                    <>
                      <Button size="sm" variant="ghost" aria-label={`Editar ${i.description}`} onClick={() => setEditing(i)}><Pencil className="size-3.5" aria-hidden /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Remover ${i.description}`} onClick={() => window.confirm('Remover esta etapa?') && removeItem.mutate(i.id)}><Trash2 className="size-3.5" aria-hidden /></Button>
                    </>
                  )}
                </li>
              ))}
              {!items.length && <li className="px-5 py-6 text-sm text-muted">Nenhuma etapa. Adicione procedimentos para montar o plano.</li>}
            </ul>
          </Card>

          {['approved', 'in_progress', 'completed'].includes(plan.status) && (
            <Card className="p-5">
              <h2 className="mb-4 font-bold">Jornada do tratamento</h2>
              <TreatmentJourney items={items} tz={tz} />
            </Card>
          )}
        </div>

        <aside className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-3 font-bold">Orçamento</h2>
            {!quote && <p className="text-sm text-muted">Ainda não apresentado.</p>}
            {quote && current && (
              <div className="space-y-3">
                <p className="text-sm">Versão vigente: <strong>v{current.version}</strong> · apresentada por {current.presentedByName} em {fmtDateTime(current.presentedAt, tz)}</p>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{fmtMoney(current.subtotal)}</dd></div>
                  {current.discount !== '0.00' && <div className="flex justify-between"><dt className="text-muted">Desconto ({current.discountReason})</dt><dd>− {fmtMoney(current.discount)}</dd></div>}
                  <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd>{fmtMoney(current.total)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Condições</dt><dd>{current.paymentTerms.installments}x · {METHOD[current.paymentTerms.method as keyof typeof METHOD] ?? current.paymentTerms.method}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Válido até</dt><dd>{fmtCivilDate(current.validUntil)}</dd></div>
                </dl>
                {quote.status === 'presented' && can('quotes.approve') && (
                  <div className="flex gap-2">
                    <Button size="sm" icon={<CheckCircle2 className="size-4" aria-hidden />} onClick={() => setDecision('approved')}>Aprovado</Button>
                    <Button size="sm" variant="secondary" icon={<XCircle className="size-4" aria-hidden />} onClick={() => setDecision('rejected')}>Recusado</Button>
                  </div>
                )}
                {quote.status !== 'presented' && <Badge tone={quote.status === 'approved' ? 'accent' : 'danger'}>{quote.status === 'approved' ? 'Aprovado' : quote.status === 'expired' ? 'Expirado' : 'Recusado'}</Badge>}
              </div>
            )}
            {quote && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-semibold">Histórico de versões e decisões</summary>
                <ol className="mt-2 space-y-2">
                  {quote.versions.map((v) => (
                    <li key={v.id}>v{v.version} · {fmtMoney(v.total)} · {fmtDateTime(v.presentedAt, tz)}{v.id === quote.currentVersionId ? ' (vigente)' : ''}</li>
                  ))}
                  {quote.decisions.map((d) => (
                    <li key={d.id} className="text-muted">
                      {d.decision === 'approved' ? 'Aprovado' : 'Recusado'} (v{quote.versions.find((v) => v.id === d.versionId)?.version}) {d.via === 'portal' ? 'pelo paciente no portal' : `registrado por ${d.decidedByName}`} · {fmtDateTime(d.createdAt, tz)}
                      {d.reason ? ` · ${d.reason}` : ''}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </Card>
          {can('treatments.write') && (
            <Card className="p-5">
              <Checkbox label="Disponibilizar no portal do paciente" description="O paciente verá o plano, os valores e poderá aprovar a versão vigente." checked={plan.sharedWithPatient} onChange={(e) => share.mutate(e.target.checked)} />
              <p className="mt-2 flex items-center gap-1 text-xs text-muted"><Eye className="size-3.5" aria-hidden /> Nada clínico além do plano é compartilhado.</p>
            </Card>
          )}
        </aside>
      </div>

      <ItemDialog planId={id} item={editing === 'new' ? null : editing} items={items} open={editing !== null} onClose={() => setEditing(null)} />
      <PresentDialog planId={id} total={q.data.totals.itemsTotal} open={presenting} onClose={() => setPresenting(false)} />
      {quote && current && <DecisionDialog quote={quote} version={current} decision={decision} onClose={() => setDecision(null)} />}
      {agenda.data && <NewAppointmentDialog open={!!scheduling} onClose={() => setScheduling(null)} agenda={agenda.data} defaults={scheduling ?? { date: todayInTz(tz), time: '09:00' }} />}
    </>
  );
}
