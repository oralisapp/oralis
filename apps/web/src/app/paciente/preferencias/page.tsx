'use client';

import { COMMUNICATION_CATEGORY_LABEL } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePortal } from '@/components/portal-context';
import { Button } from '@/components/ui/button';
import { Card, LoadingBlock, Notice } from '@/components/ui/feedback';
import { Field, Input, Textarea } from '@/components/ui/field';
import { api } from '@/lib/api';
import { usePortalQuery, usePortalRequests } from '@/lib/portal';

interface Pref { channel: 'email' | 'sms' | 'whatsapp'; category: 'transactional' | 'relationship' | 'promotional'; allowed: boolean }
const CHANNEL = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' } as const;

export default function PortalPreferences() {
  const me = usePortal();
  const qc = useQueryClient();
  const prefs = usePortalQuery<Pref[]>('communication', '/communication');
  const reqs = usePortalRequests();
  const toggle = useMutation({ mutationFn: (p: Pref) => api.put('/portal/communication', { preferences: [{ channel: p.channel, category: p.category, allowed: !p.allowed }] }), onSuccess: () => qc.invalidateQueries({ queryKey: ['portal'] }) });
  const [f, setF] = useState({ phone: '', email: '', address: '', message: '' });
  const [sent, setSent] = useState(false);
  const update = useMutation({ mutationFn: () => api.post('/portal/profile-update', Object.fromEntries(Object.entries(f).filter(([, v]) => v))), onSuccess: async () => { setSent(true); await qc.invalidateQueries({ queryKey: ['portal'] }); } });
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Preferências</h1>
      <Card className="p-5">
        <h2 className="font-bold">Como a clínica pode falar com você</h2>
        <p className="mb-3 text-sm text-muted">Você pode mudar quando quiser.</p>
        {prefs.isLoading ? <LoadingBlock rows={2} /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1">Tipo</th>{Object.values(CHANNEL).map((c) => <th key={c} className="py-1 text-center">{c}</th>)}</tr></thead>
            <tbody>{(['transactional', 'relationship', 'promotional'] as const).map((cat) => <tr key={cat} className="border-t border-border"><td className="py-2">{COMMUNICATION_CATEGORY_LABEL[cat]}</td>{(['email', 'sms', 'whatsapp'] as const).map((ch) => { const p = prefs.data?.find((x) => x.channel === ch && x.category === cat); return <td key={ch} className="py-2 text-center"><input type="checkbox" className="size-4 accent-[var(--primary)]" aria-label={`${COMMUNICATION_CATEGORY_LABEL[cat]} por ${CHANNEL[ch]}`} checked={!!p?.allowed} onChange={() => p && toggle.mutate(p)} /></td>; })}</tr>)}</tbody>
          </table>
        )}
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-bold">Atualizar meus dados</h2>
        <p className="text-sm text-muted">Cadastro atual: {me.patient.phone ?? 'sem telefone'} · {me.patient.email ?? 'sem e-mail'}. A clínica confere e atualiza.</p>
        {sent ? <Notice tone="accent">Pedido enviado à clínica.</Notice> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Novo telefone">{(p) => <Input {...p} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
              <Field label="Novo e-mail">{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
            </div>
            <Field label="Endereço">{(p) => <Input {...p} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />}</Field>
            <Field label="Mensagem">{(p) => <Textarea {...p} rows={2} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />}</Field>
            <Button loading={update.isPending} disabled={!Object.values(f).some(Boolean)} onClick={() => update.mutate()}>Enviar para a clínica</Button>
          </>
        )}
      </Card>
      {reqs.data && reqs.data.length > 0 && (
        <Card className="p-5"><h2 className="mb-2 font-bold">Acompanhar solicitações</h2><ul className="space-y-1 text-sm">{reqs.data.map((r) => <li key={r.id} className="flex justify-between"><span>{r.title.split(':')[0]}</span><span>{r.status === 'open' ? 'Em andamento' : 'Atendida'}</span></li>)}</ul></Card>
      )}
    </div>
  );
}
