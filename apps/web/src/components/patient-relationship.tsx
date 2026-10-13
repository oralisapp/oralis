'use client';

import { COMMUNICATION_CATEGORY_LABEL } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HeartHandshake, MessageSquare, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtPhone } from '@/lib/format';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';

interface Pref {
  channel: 'email' | 'sms' | 'whatsapp';
  category: 'transactional' | 'relationship' | 'promotional';
  allowed: boolean;
  explicit: boolean;
}
const CHANNEL = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' } as const;

function Communication({ patientId }: { patientId: string }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useOrgQuery<Pref[]>(['patient-comm', patientId], `/patients/${patientId}/communication`);
  const save = useMutation({
    mutationFn: (p: Pref) => api.put(`/orgs/${orgId}/patients/${patientId}/communication`, { preferences: [{ channel: p.channel, category: p.category, allowed: !p.allowed }] }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Autorização atualizada', description: 'A alteração foi registrada na auditoria.' });
      await qc.invalidateQueries({ queryKey: ['org', orgId, 'patient-comm', patientId] });
    },
  });
  return (
    <Card>
      <CardHeader icon={<MessageSquare className="size-5" aria-hidden />} title="Autorizações de comunicação" description="Avisos do atendimento valem salvo recusa. Relacionamento e campanhas só com autorização registrada." />
      {q.isLoading ? <LoadingBlock rows={2} /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-muted"><th className="px-5 py-2 font-semibold">Tipo de mensagem</th>{Object.values(CHANNEL).map((c) => <th key={c} className="px-3 py-2 text-center font-semibold">{c}</th>)}</tr></thead>
            <tbody>
              {(['transactional', 'relationship', 'promotional'] as const).map((cat) => (
                <tr key={cat} className="border-b border-border last:border-0">
                  <th scope="row" className="px-5 py-2.5 text-left font-normal">{COMMUNICATION_CATEGORY_LABEL[cat]}</th>
                  {(['email', 'sms', 'whatsapp'] as const).map((ch) => {
                    const p = q.data?.find((x) => x.channel === ch && x.category === cat);
                    return (
                      <td key={ch} className="px-3 py-2.5 text-center">
                        <input type="checkbox" className="size-4 accent-[var(--primary)]" aria-label={`${COMMUNICATION_CATEGORY_LABEL[cat]} por ${CHANNEL[ch]}`} checked={!!p?.allowed} disabled={!can('patients.write') || save.isPending} onChange={() => p && save.mutate(p)} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-5 pb-4 text-xs text-subtle">WhatsApp e SMS dependem de provedor configurado; sem ele, nenhuma mensagem é enviada por esses canais.</p>
    </Card>
  );
}

function Preferences({ patientId }: { patientId: string }) {
  const { orgId, can } = useOrg();
  const toast = useToast();
  const q = useOrgQuery<{ preferredChannel: string | null; preferredPeriod: string | null; accessibilityNeeds: string | null; welcomeNotes: string | null }>(['patient-prefs', patientId], `/patients/${patientId}/preferences`);
  const [f, setF] = useState({ preferredChannel: '', preferredPeriod: '', accessibilityNeeds: '', welcomeNotes: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setF({ preferredChannel: q.data.preferredChannel ?? '', preferredPeriod: q.data.preferredPeriod ?? '', accessibilityNeeds: q.data.accessibilityNeeds ?? '', welcomeNotes: q.data.welcomeNotes ?? '' });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put(`/orgs/${orgId}/patients/${patientId}/preferences`, f),
    onSuccess: () => toast({ tone: 'success', title: 'Preferências salvas' }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro ao salvar.'),
  });
  const ro = !can('patients.write');
  return (
    <Card>
      <CardHeader icon={<HeartHandshake className="size-5" aria-hidden />} title="Preferências de atendimento" description="Registre apenas o que ajuda a acolher melhor, com finalidade clara." />
      <form className="grid gap-4 p-5 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="sm:col-span-2"><FormError message={error} /></div>
        <Field label="Canal preferido">{(p) => <Select {...p} disabled={ro} value={f.preferredChannel} onChange={(e) => setF({ ...f, preferredChannel: e.target.value })}><option value="">Não informado</option><option value="phone">Telefone</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="email">E-mail</option></Select>}</Field>
        <Field label="Período preferido">{(p) => <Select {...p} disabled={ro} value={f.preferredPeriod} onChange={(e) => setF({ ...f, preferredPeriod: e.target.value })}><option value="">Não informado</option><option value="morning">Manhã</option><option value="afternoon">Tarde</option><option value="evening">Noite</option></Select>}</Field>
        <Field label="Necessidades de acessibilidade" className="sm:col-span-2" hint="Ex.: usa cadeira de rodas; prefere comunicação por escrito.">{(p) => <Textarea {...p} disabled={ro} rows={2} maxLength={300} value={f.accessibilityNeeds} onChange={(e) => setF({ ...f, accessibilityNeeds: e.target.value })} />}</Field>
        <Field label="Observações para acolhimento" className="sm:col-span-2" hint="Não registre informações clínicas nem avaliações sobre a pessoa.">{(p) => <Textarea {...p} disabled={ro} rows={2} maxLength={300} value={f.welcomeNotes} onChange={(e) => setF({ ...f, welcomeNotes: e.target.value })} />}</Field>
        {!ro && <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Salvar preferências</Button></div>}
      </form>
    </Card>
  );
}

interface Rep { id: string; fullName: string; relationship: string; phone: string | null; email: string | null; isLegalGuardian: boolean }

function Representatives({ patientId }: { patientId: string }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const q = useOrgQuery<Rep[]>(['patient-reps', patientId], `/patients/${patientId}/representatives`);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ fullName: '', relationship: '', cpf: '', phone: '', email: '', isLegalGuardian: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'patient-reps', patientId] });
  const add = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/patients/${patientId}/representatives`, f),
    onSuccess: async () => { setAdding(false); setF({ fullName: '', relationship: '', cpf: '', phone: '', email: '', isLegalGuardian: true }); await refresh(); },
    onError: (err) => err instanceof ApiError && setErrors({ ...err.fieldErrors, _: err.message }),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/orgs/${orgId}/patients/${patientId}/representatives/${id}`), onSuccess: refresh });
  return (
    <Card>
      <CardHeader icon={<UserPlus className="size-5" aria-hidden />} title="Responsáveis" description="Responsável legal (menores ou pessoas sob curatela) e contatos autorizados." actions={can('patients.write') && !adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Adicionar</Button>} />
      <ul className="divide-y divide-border">
        {q.data?.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-5 py-3 text-sm">
            <div className="flex-1"><p className="font-semibold">{r.fullName} <span className="font-normal text-muted">· {r.relationship}{r.isLegalGuardian ? ' · responsável legal' : ''}</span></p><p className="text-muted">{[r.phone && fmtPhone(r.phone), r.email].filter(Boolean).join(' · ') || 'Sem contato'}</p></div>
            {can('patients.write') && <button type="button" aria-label={`Remover ${r.fullName}`} onClick={() => remove.mutate(r.id)} className="rounded p-1.5 text-muted hover:text-danger"><Trash2 className="size-4" aria-hidden /></button>}
          </li>
        ))}
        {q.data?.length === 0 && !adding && <li className="px-5 py-4 text-sm text-muted">Nenhum responsável cadastrado.</li>}
      </ul>
      {adding && (
        <form className="grid gap-3 border-t border-border p-5 sm:grid-cols-2" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); setErrors({}); add.mutate(); }}>
          <div className="sm:col-span-2"><FormError message={errors._ && !Object.keys(errors).some((k) => k !== '_') ? errors._ : null} /></div>
          <Field label="Nome" required error={errors.fullName}>{(p) => <Input {...p} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
          <Field label="Parentesco / vínculo" required error={errors.relationship}>{(p) => <Input {...p} value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} />}</Field>
          <Field label="Telefone" error={errors.phone}>{(p) => <Input {...p} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <Field label="E-mail" error={errors.email}>{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="CPF" error={errors.cpf}>{(p) => <Input {...p} value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} />}</Field>
          <div className="flex items-end"><Checkbox label="Responsável legal" checked={f.isLegalGuardian} onChange={(e) => setF({ ...f, isLegalGuardian: e.target.checked })} /></div>
          <div className="flex gap-2 sm:col-span-2"><Button type="submit" loading={add.isPending}>Salvar</Button><Button variant="ghost" onClick={() => setAdding(false)}>Cancelar</Button></div>
        </form>
      )}
    </Card>
  );
}

export function PatientRelationship({ patientId }: { patientId: string }) {
  return (
    <div className="space-y-4">
      <Communication patientId={patientId} />
      <Preferences patientId={patientId} />
      <Representatives patientId={patientId} />
    </div>
  );
}
