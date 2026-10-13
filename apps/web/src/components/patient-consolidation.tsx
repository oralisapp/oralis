'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '@/lib/api';
import { useOrg } from '@/lib/session';
import { type PatientDetail, type PatientListItem } from '@/lib/queries';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, Input, Textarea, FormError, Checkbox } from './ui/field';
import { ErrorState } from './ui/feedback';

export function PatientConsolidation({ patient }: { patient: PatientDetail['patient'] }) {
  const { orgId, can, membership } = useOrg(); const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const [targetId, setTargetId] = useState(''); const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const links = useQuery({ queryKey: ['org', orgId, 'patient-registrations', patient.id], queryFn: () => api.get<{ items: { id: string; fullName: string; direction: string }[] }>(`/orgs/${orgId}/patients/${patient.id}/registrations`) });
  const candidates = useQuery({ queryKey: ['org', orgId, 'consolidation-candidates', query], queryFn: () => api.get<{ items: PatientListItem[] }>(`/orgs/${orgId}/patients${qs({ q: query, page: 1 })}`), enabled: open });
  const target = useQuery({ queryKey: ['org', orgId, 'patient', targetId], queryFn: () => api.get<PatientDetail>(`/orgs/${orgId}/patients/${targetId}`), enabled: open && !!targetId, refetchOnWindowFocus: false });
  async function consolidate() {
    if (!target.data) return; setBusy(true); setError('');
    try { await api.post(`/orgs/${orgId}/patients/consolidate`, { sourceId: patient.id, targetId, sourceVersion: patient.version, targetVersion: target.data.patient.version, reason }); await qc.invalidateQueries({ queryKey: ['org', orgId] }); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Falha ao consolidar.'); } finally { setBusy(false); }
  }
  return <div className="mb-4 space-y-3 rounded-xl border border-border p-4 text-sm">
    {links.error && <ErrorState error={links.error} onRetry={() => links.refetch()} />}
    {links.data?.items.map(item => <p key={item.id}>{item.direction === 'canonical' ? 'Cadastro consolidado. Novos atendimentos devem usar: ' : 'Histórico anterior preservado (prontuário, agenda, documentos e financeiro): '}<Link className="font-semibold text-primary-text underline" href={`/app/pacientes/${item.id}`}>{item.fullName}</Link></p>)}
    {!!links.data?.items.length && <p className="text-muted">As abas desta ficha exibem somente seus registros originais. Consulte também os cadastros vinculados. O acesso do portal continua restrito ao cadastro original.</p>}
    {patient.status === 'active' && can('patients.write') && membership.allUnits && ['owner', 'manager'].includes(membership.role.key ?? '') && <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Consolidar cadastro duplicado</Button>}
    <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} title="Consolidar cadastro duplicado" description={`Este cadastro (${patient.fullName}) será arquivado. Escolha o cadastro principal para os próximos atendimentos. Dados pessoais e históricos não serão copiados ou alterados.`}>
      <div className="space-y-4">
        <Field label="Buscar cadastro principal" required>{p => <Input {...p} value={query} disabled={busy} onChange={e => { setQuery(e.target.value); setTargetId(''); setConfirmed(false); }} />}</Field>
        {candidates.error && <ErrorState error={candidates.error} />}
        <div className="max-h-40 overflow-auto space-y-2">{candidates.data?.items.filter(p => p.id !== patient.id).map(p => <label key={p.id} className="flex gap-2"><input type="radio" name="canonical-patient" checked={targetId === p.id} disabled={busy} onChange={() => { setTargetId(p.id); setConfirmed(false); }} />{p.fullName} · {p.birthDate || 'Sem nascimento'} · {p.phone || 'Sem telefone'}</label>)}</div>
        {targetId && target.error && <ErrorState error={target.error} />}
        {targetId && target.data && <p>Principal: <strong>{target.data.patient.fullName}</strong> · CPF: {target.data.patient.cpf || 'Não informado'} · E-mail: {target.data.patient.email || 'Não informado'}</p>}
        <Field label="Motivo da consolidação" required hint="De 10 a 500 caracteres. Não inclua dados clínicos.">{p => <Textarea {...p} value={reason} minLength={10} maxLength={500} disabled={busy} onChange={e => setReason(e.target.value)} />}</Field>
        <Checkbox label="Conferi que os dois cadastros pertencem à mesma pessoa e que o principal está correto." checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />
        <FormError message={error} /><Button disabled={busy || !confirmed || !targetId || !target.data || reason.trim().length < 10} onClick={() => void consolidate()}>Confirmar consolidação</Button>
      </div>
    </Dialog>
  </div>;
}
