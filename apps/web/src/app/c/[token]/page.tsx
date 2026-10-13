'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarCheck2, CalendarClock, CheckCircle2, MapPin, Phone, UserRound } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { FormError, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDate, fmtPhone, fmtTime } from '@/lib/format';

interface LinkView {
  state: 'pending' | 'confirmed' | 'reschedule_requested' | 'cancelled' | 'expired' | 'changed';
  clinicName: string;
  unitName: string;
  unitAddress: string | null;
  unitPhone: string | null;
  timezone: string;
  startsAt: string;
  professionalName: string;
  patientFirstName: string;
}

/** Página do paciente (sem login): confirma presença ou pede outro horário. */
export default function ConfirmationPage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({ queryKey: ['link', token], queryFn: () => api.get<LinkView>(`/public/appointment-links/${token}`), retry: false });
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState('');
  const confirm = useMutation({ mutationFn: () => api.post(`/public/appointment-links/${token}/confirm`), onSuccess: () => q.refetch() });
  const reschedule = useMutation({ mutationFn: () => api.post(`/public/appointment-links/${token}/reschedule-request`, { message }), onSuccess: () => q.refetch() });
  const err = (confirm.error ?? reschedule.error) as unknown;

  return (
    <div className="min-h-dvh px-4 py-8">
      <div className="mx-auto max-w-md">
        <Logo />
        <div className="mt-8">
          {q.isLoading && <Card><LoadingBlock rows={3} /></Card>}
          {q.error && (q.error instanceof ApiError && q.error.status === 404 ? <Notice tone="warning" title="Link inválido">Confira se o endereço foi copiado inteiro ou fale com a clínica.</Notice> : <ErrorState error={q.error} />)}
          {q.data && (
            <Card className="p-6">
              <p className="text-sm font-semibold text-primary-text">{q.data.clinicName}</p>
              <h1 className="mt-1 text-2xl font-extrabold">Olá, {q.data.patientFirstName}!</h1>
              <ul className="mt-5 space-y-3 text-[15px]">
                <li className="flex gap-3"><CalendarClock className="mt-0.5 size-5 text-primary" aria-hidden /><span><strong>{fmtDate(q.data.startsAt, q.data.timezone, { weekday: 'long', day: 'numeric', month: 'long' })}</strong> às <strong>{fmtTime(q.data.startsAt, q.data.timezone)}</strong></span></li>
                <li className="flex gap-3"><UserRound className="mt-0.5 size-5 text-primary" aria-hidden />{q.data.professionalName}</li>
                <li className="flex gap-3"><MapPin className="mt-0.5 size-5 text-primary" aria-hidden /><span>{q.data.unitName}{q.data.unitAddress ? ` — ${q.data.unitAddress}` : ''}</span></li>
                {q.data.unitPhone && <li className="flex gap-3"><Phone className="mt-0.5 size-5 text-primary" aria-hidden />{fmtPhone(q.data.unitPhone)}</li>}
              </ul>
              <div className="mt-6 space-y-3">
                <FormError message={err instanceof ApiError ? err.message : null} />
                {q.data.state === 'pending' && !asking && (
                  <>
                    <Button className="w-full" icon={<CalendarCheck2 className="size-4" aria-hidden />} loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirmar presença</Button>
                    <Button className="w-full" variant="secondary" onClick={() => setAsking(true)}>Preciso de outro horário</Button>
                  </>
                )}
                {asking && q.data.state === 'pending' && (
                  <div className="space-y-2">
                    <label htmlFor="msg" className="text-sm font-semibold">Quer deixar uma mensagem? (opcional)</label>
                    <Textarea id="msg" rows={3} maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ex.: prefiro no fim da tarde" />
                    <p className="text-xs text-muted">Não escreva informações de saúde aqui. A clínica entrará em contato para combinar.</p>
                    <Button className="w-full" loading={reschedule.isPending} onClick={() => reschedule.mutate()}>Pedir reagendamento</Button>
                    <Button className="w-full" variant="ghost" onClick={() => setAsking(false)}>Voltar</Button>
                  </div>
                )}
                {q.data.state === 'confirmed' && <Notice tone="accent" icon={<CheckCircle2 className="size-5" aria-hidden />} title="Presença confirmada">Obrigado! Até lá.</Notice>}
                {q.data.state === 'reschedule_requested' && <Notice tone="info" title="Pedido enviado">A clínica vai entrar em contato para combinar um novo horário. Sua consulta atual continua marcada até lá.</Notice>}
                {q.data.state === 'cancelled' && <Notice tone="warning">Esta consulta foi cancelada. Fale com a clínica para remarcar.</Notice>}
                {q.data.state === 'expired' && <Notice tone="warning">Este link expirou.</Notice>}
                {q.data.state === 'changed' && <Notice tone="warning">A consulta mudou depois que este link foi enviado. Fale com a clínica para receber o link atualizado.</Notice>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
