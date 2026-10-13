'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MapPin } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { FormError, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDate, fmtTime } from '@/lib/format';
import { usePortalAppointments } from '@/lib/portal';

export default function PortalAppointments() {
  const qc = useQueryClient();
  const q = usePortalAppointments();
  const [asking, setAsking] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['portal'] });
  const confirm = useMutation({ mutationFn: (id: string) => api.post(`/portal/appointments/${id}/confirm`), onSuccess: refresh });
  const resched = useMutation({ mutationFn: (id: string) => api.post(`/portal/appointments/${id}/reschedule-request`, { message: msg || undefined }), onSuccess: async (_r, id) => { setDone(id); setAsking(null); setMsg(''); await refresh(); } });
  const err = (confirm.error ?? resched.error) as unknown;
  if (q.isLoading) return <LoadingBlock rows={3} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Suas consultas</h1>
      <FormError message={err instanceof ApiError ? err.message : null} />
      {q.data?.upcoming.length === 0 && <Card><EmptyState icon={<CheckCircle2 className="size-5" aria-hidden />} title="Nenhuma consulta marcada" /></Card>}
      {q.data?.upcoming.map((a) => (
        <Card key={a.id} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-lg font-bold">{fmtDate(a.startsAt, a.timezone, { weekday: 'long', day: 'numeric', month: 'long' })} às {fmtTime(a.startsAt, a.timezone)}</p>
              <p className="text-sm text-muted">{a.professionalName}{a.serviceName ? ` · ${a.serviceName}` : ''}</p>
              <p className="mt-1 flex items-center gap-1 text-sm text-muted"><MapPin className="size-4" aria-hidden /> {a.unitName}{a.address ? ` — ${a.address}` : ''}</p>
            </div>
            <StatusBadge status={a.status} />
          </div>
          {done === a.id && <div className="mt-3"><Notice tone="info">Pedido enviado. A clínica vai entrar em contato; esta consulta continua marcada até lá.</Notice></div>}
          <div className="mt-4 flex flex-wrap gap-2">
            {a.status === 'scheduled' && <Button loading={confirm.isPending && confirm.variables === a.id} onClick={() => confirm.mutate(a.id)}>Confirmar presença</Button>}
            {['scheduled', 'confirmed'].includes(a.status) && asking !== a.id && <Button variant="secondary" onClick={() => setAsking(a.id)}>Preciso de outro horário</Button>}
          </div>
          {asking === a.id && (
            <div className="mt-3 space-y-2">
              <Textarea aria-label="Mensagem para a clínica" rows={2} maxLength={300} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Opcional: diga os melhores dias e horários. Não escreva informações de saúde." />
              <div className="flex gap-2"><Button loading={resched.isPending} onClick={() => resched.mutate(a.id)}>Enviar pedido</Button><Button variant="ghost" onClick={() => setAsking(null)}>Voltar</Button></div>
            </div>
          )}
        </Card>
      ))}
      {q.data && q.data.past.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 font-bold">Histórico</h2>
          <ul className="space-y-2 text-sm">{q.data.past.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2"><span>{fmtDate(a.startsAt, a.timezone, { dateStyle: 'short' })} · {a.professionalName}</span><StatusBadge status={a.status} /></li>)}</ul>
        </Card>
      )}
    </div>
  );
}
