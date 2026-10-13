'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { useOrg } from '@/lib/session';
import { ApiError, qs } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/ui/feedback';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Choice, dateLabel, OperationForm, TextField, useOperation } from '@/components/operations/shared';

type Lab = { id: string; name: string; phone: string | null; email: string | null; notes: string | null };
type Order = { id: string; unitId: string; patientName: string; labName: string; professionalName: string | null; work: string; instructions: string | null; shade: string | null; dueDate: string; cost: string | null; status: string; late: boolean; reworkCount: number };
type Detail = { order: Order; events: { id: string; toStatus: string; byName: string; createdAt: string; note: string | null; rework: boolean }[] };
type Sheet = { patient: string; work: string; instructions: string | null; shade: string | null; dueDate: string; lab: string; professional: string | null };
const statusNames: Record<string, string> = { requested: 'Solicitado', sent: 'Enviado', in_production: 'Em produção', received: 'Recebido', delivered: 'Entregue', cancelled: 'Cancelado' };
const nextStatuses: Record<string, string[]> = { requested: ['sent', 'cancelled'], sent: ['in_production', 'received', 'cancelled'], in_production: ['received', 'cancelled'], received: ['delivered', 'sent'], delivered: ['sent'], cancelled: [] };

export default function LaboratoriesPage() {
  const { membership, unit } = useOrg();
  return <LabsWorkspace key={`${membership.organizationId}:${unit?.id}`} />;
}
function LabsWorkspace() {
  const { can, unit, membership } = useOrg();
  const allowed = can('labs.read');
  const writable = can('labs.write') && membership.subscription.access === 'full';
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('open');
  const [selected, setSelected] = useState<Order | null>(null);
  const [patientSearch, setPatientSearch] = useState('');
  const [patientId, setPatientId] = useState('');
  const [planId, setPlanId] = useState('');
  const labs = useOperation<Lab[]>('/labs', allowed);
  const orders = useOperation<Order[]>(`/labs/orders${qs({ status, unitId: unit?.id })}`, allowed && !!unit);
  const detail = useOperation<Detail>(`/labs/orders/${selected?.id}`, allowed && !!selected);
  const sheet = useOperation<Sheet>(`/labs/orders/${selected?.id}/sheet`, allowed && !!selected && mode === 'sheet');
  const patients = useOperation<{ items: { id: string; fullName: string }[] }>(`/patients${qs({ q: patientSearch, page: 1 })}`, mode === 'order' && can('patients.read'));
  const professionals = useOperation<{ id: string; displayName: string }[]>('/professionals', mode === 'order');
  const plans = useOperation<{ id: string; title: string }[]>(`/patients/${patientId}/treatment-plans`, mode === 'order' && !!patientId && can('treatments.read'));
  const plan = useOperation<{ items: { id: string; description: string }[] }>(`/treatment-plans/${planId}`, mode === 'order' && !!planId && can('treatments.read'));
  const close = () => { setMode(''); setSelected(null); };
  if (!allowed) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  const visible = orders.data?.filter(o => o.unitId === unit?.id);
  return <>
    <PageHeader title="Laboratórios" description={`Acompanhe prazos, entregas e retrabalhos · ${unit?.name ?? 'Selecione uma unidade'}`} actions={writable && unit && <Button onClick={() => { setPatientId(''); setPatientSearch(''); setPlanId(''); setMode('order'); }}>Solicitar trabalho</Button>} />
    <div className="space-y-6"><Card><CardHeader title="Trabalhos" description="Até 500 trabalhos por filtro, organizados por prazo." actions={<Select aria-label="Filtrar trabalhos por situação" value={status} onChange={e => setStatus(e.target.value)}><option value="open">Em aberto</option><option value="">Todas as situações</option>{Object.entries(statusNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>} />
      {orders.isLoading && <LoadingBlock />}{orders.error && <ErrorState error={orders.error} onRetry={() => orders.refetch()} />}{visible?.length === 0 && <EmptyState icon={<FlaskConical />} title="Nenhum trabalho nesta seleção" description="Solicite um trabalho ou altere o filtro de situação." />}
      <ul className="divide-y divide-border">{visible?.map(o => <li key={o.id} className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="flex-1"><p className="font-semibold">{o.work}</p><p className="text-sm text-muted">{o.patientName} · {o.labName}</p><p className="text-xs text-muted">Prazo {dateLabel(o.dueDate)}{o.reworkCount > 0 ? ` · ${o.reworkCount} retrabalho(s)` : ''}</p></div><Badge tone={o.late ? 'danger' : o.status === 'received' ? 'accent' : 'neutral'}>{o.late ? 'Atrasado · ' : ''}{statusNames[o.status]}</Badge><Button variant="secondary" size="sm" onClick={() => { setSelected(o); setMode('detail'); }}>Abrir trabalho</Button></li>)}</ul>
    </Card><Card><CardHeader title="Laboratórios parceiros" actions={writable && <Button size="sm" onClick={() => setMode('lab')}>Cadastrar laboratório</Button>} />{labs.isLoading && <LoadingBlock />}{labs.error && <ErrorState error={labs.error} onRetry={() => labs.refetch()} />}<ul className="divide-y divide-border">{labs.data?.map(l => <li key={l.id} className="px-5 py-4"><p className="font-semibold">{l.name}</p><p className="text-sm text-muted">{[l.phone, l.email].filter(Boolean).join(' · ') || 'Sem contato cadastrado'}</p>{l.notes && <p className="mt-1 text-sm">{l.notes}</p>}</li>)}</ul>{labs.data?.length === 0 && <p className="p-5 text-muted">Nenhum laboratório cadastrado.</p>}</Card></div>
    {mode === 'lab' && <OperationForm title="Cadastrar laboratório" path="/labs" onClose={close}><TextField name="name" label="Nome" required maxLength={120} /><TextField name="phone" label="Telefone" maxLength={30} /><TextField name="email" label="E-mail" type="email" maxLength={254} /><TextField name="notes" label="Observações" maxLength={500} /></OperationForm>}
    {mode === 'order' && unit && <OperationForm title="Solicitar trabalho" path="/labs/orders" onClose={close} transform={d => ({ ...d, patientId, unitId: unit.id })}>
      {!can('patients.read') && <p className="text-danger">É necessário acesso à lista de pacientes para selecionar o paciente.</p>}
      <Field label="Buscar paciente" required>{p => <Input {...p} required={false} value={patientSearch} onChange={e => setPatientSearch(e.target.value)} placeholder="Nome, CPF ou telefone" />}</Field>
      {patients.isLoading && <LoadingBlock />}{patients.error && <ErrorState error={patients.error} onRetry={() => patients.refetch()} />}
      <Field label="Paciente" required>{p => <Select {...p} value={patientId} onChange={e => { setPatientId(e.target.value); setPlanId(''); }}><option value="">Selecione…</option>{patients.data?.items.map(p => <option key={p.id} value={p.id}>{p.fullName}</option>)}</Select>}</Field>
      <Choice name="laboratoryId" label="Laboratório" options={labs.data ?? []} />
      {professionals.error && <ErrorState error={professionals.error} onRetry={() => professionals.refetch()} />}<Choice name="professionalId" label="Profissional responsável" options={professionals.data?.map(p => ({ id: p.id, name: p.displayName })) ?? []} required={false} />
      {can('treatments.read') && patientId && <><Field label="Plano de tratamento">{p => <Select {...p} value={planId} onChange={e => setPlanId(e.target.value)}><option value="">Sem vínculo</option>{plans.data?.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</Select>}</Field>{plans.error && <ErrorState error={plans.error} onRetry={() => plans.refetch()} />}{planId && <><Choice key={planId} name="treatmentItemId" label="Etapa do tratamento" options={plan.data?.items.map(i => ({ id: i.id, name: i.description })) ?? []} required />{plan.error && <ErrorState error={plan.error} onRetry={() => plan.refetch()} />}</>}</>}
      <TextField name="work" label="Trabalho solicitado" required maxLength={200} /><Field label="Instruções para o laboratório">{p => <Textarea {...p} name="instructions" maxLength={2000} />}</Field><TextField name="shade" label="Cor" maxLength={40} /><TextField name="dueDate" label="Prazo" type="date" required /><TextField name="cost" label="Custo (R$)" type="number" min="0" step="0.01" />
    </OperationForm>}
    {mode === 'detail' && selected && <Dialog open title={selected.work} onClose={close}>{detail.isLoading && <LoadingBlock />}{detail.error && <ErrorState error={detail.error} onRetry={() => detail.refetch()} />}{detail.data && <div className="space-y-4"><p>{detail.data.order.patientName} · {detail.data.order.labName}</p><Badge>{statusNames[detail.data.order.status]}</Badge><p>Prazo: {dateLabel(detail.data.order.dueDate)} · Cor: {detail.data.order.shade ?? 'Não informada'}</p><p>Responsável: {detail.data.order.professionalName ?? 'Não informado'} · Custo: {detail.data.order.cost ? Number(detail.data.order.cost).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado'}</p><p className="whitespace-pre-wrap text-sm">{detail.data.order.instructions ?? 'Sem instruções adicionais.'}</p><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setMode('sheet')}>Ficha para o laboratório</Button>{writable && !!nextStatuses[detail.data.order.status]?.length && <Button onClick={() => { setSelected(detail.data!.order); setMode('status'); }}>Atualizar situação</Button>}</div><h3 className="font-semibold">Histórico</h3><ul className="divide-y divide-border">{detail.data.events.map(e => <li key={e.id} className="py-3"><p>{statusNames[e.toStatus]}{e.rework ? ' · retrabalho' : ''}</p><p className="text-xs text-muted">{dateLabel(e.createdAt)} · {e.byName}</p>{e.note && <p className="text-sm">{e.note}</p>}</li>)}</ul></div>}</Dialog>}
    {mode === 'status' && selected && <OperationForm title="Atualizar situação" path={`/labs/orders/${selected.id}/status`} onClose={close}><p className="text-sm">Situação atual: {statusNames[selected.status]}. O reenvio após recebimento ou entrega registra retrabalho.</p><Choice name="to" label="Nova situação" options={(nextStatuses[selected.status] ?? []).map(id => ({ id, name: id === 'sent' && ['received', 'delivered'].includes(selected.status) ? 'Reenviar para retrabalho' : statusNames[id]! }))} /><TextField name="note" label="Observação" maxLength={500} /></OperationForm>}
    {mode === 'sheet' && selected && <Dialog open title="Ficha para o laboratório" onClose={close}>{sheet.isLoading && <LoadingBlock />}{sheet.error && <ErrorState error={sheet.error} onRetry={() => sheet.refetch()} />}{sheet.data && <div className="space-y-4"><p className="text-xs text-muted">Ficha com identificação reduzida do paciente, pronta para baixar e compartilhar com o laboratório.</p><dl className="space-y-2">{Object.entries({ Paciente: sheet.data.patient, Laboratório: sheet.data.lab, Trabalho: sheet.data.work, Instruções: sheet.data.instructions, Cor: sheet.data.shade, Prazo: dateLabel(sheet.data.dueDate), Profissional: sheet.data.professional }).map(([label, value]) => <div key={label}><dt className="text-xs font-bold text-muted">{label}</dt><dd className="whitespace-pre-wrap">{value || 'Não informado'}</dd></div>)}</dl><Button onClick={() => { const s = sheet.data!; const content = `FICHA DE LABORATÓRIO\n\nPaciente: ${s.patient}\nLaboratório: ${s.lab}\nTrabalho: ${s.work}\nInstruções: ${s.instructions ?? ''}\nCor: ${s.shade ?? ''}\nPrazo: ${dateLabel(s.dueDate)}\nProfissional: ${s.professional ?? ''}`; const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `ficha-laboratorio-${selected.id}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Baixar ficha</Button></div>}</Dialog>}
  </>;
}
