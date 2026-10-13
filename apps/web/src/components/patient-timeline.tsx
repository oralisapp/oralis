'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { History } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useOrg } from '@/lib/session';
import { Button } from './ui/button';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock } from './ui/feedback';

type Cursor = { before: string; beforeKey: string } | null;
interface TimelinePage { items: { key: string; kind: string; id: string; at: string; title: string; status: string; amount: string | null }[]; next: Cursor }
const sections: Record<string, string> = { appointment: 'agendamentos', clinical: 'clinico', document: 'documentos', payment: 'financeiro', treatment: 'tratamentos' };
const labels: Record<string, string> = { appointment: 'Agenda', clinical: 'Prontuário', document: 'Documento', payment: 'Financeiro', treatment: 'Tratamento' };
const statuses: Record<string, string> = { scheduled: 'Agendada', confirmed: 'Confirmada', arrived: 'Paciente na clínica', in_progress: 'Em andamento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Não compareceu', finalized: 'Finalizado', draft: 'Rascunho', presented: 'Apresentado', approved: 'Aprovado', rejected: 'Recusado', pix: 'PIX', cash: 'Dinheiro', card_credit: 'Cartão de crédito', card_debit: 'Cartão de débito', transfer: 'Transferência', boleto: 'Boleto' };

export function PatientTimeline({ patientId }: { patientId: string }) {
  const { orgId, unit } = useOrg();
  const timezone = unit?.timezone ?? 'America/Sao_Paulo';
  const q = useInfiniteQuery({
    queryKey: ['org', orgId, 'patient-timeline', patientId],
    initialPageParam: null as Cursor,
    queryFn: ({ pageParam }) => api.get<TimelinePage>(`/orgs/${orgId}/patients/${patientId}/timeline${pageParam ? `?${new URLSearchParams(pageParam)}` : ''}`),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const items = q.data?.pages.flatMap(page => page.items) ?? [];
  return <Card className="mt-5">
    <CardHeader title="A jornada deste paciente" description="Consultas, registros finalizados, documentos, tratamentos e recebimentos disponíveis para seu acesso." />
    <p className="border-b border-border px-5 py-3 text-xs text-muted">Todos os horários são exibidos no fuso {timezone}{unit ? `, da unidade selecionada (${unit.name})` : ''}, inclusive os registros de outras unidades.</p>
    {q.isLoading && <LoadingBlock rows={4} />}
    {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
    {!q.isLoading && !q.error && !items.length && <EmptyState icon={<History className="size-5" />} title="A jornada começa aqui" description="Os registros aparecerão conforme o paciente for atendido." />}
    <ol className="divide-y divide-border">
      {items.map(item => <li key={item.key} className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span className="rounded-full bg-primary-soft p-2 text-primary-text"><History className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-wider text-muted">{labels[item.kind]}</p><Link className="font-semibold hover:underline" href={item.kind === 'treatment' ? `/app/tratamentos/${item.id}` : `/app/pacientes/${patientId}?aba=${sections[item.kind]}`}>{item.title}</Link>{item.amount && <span className="ml-2 font-semibold text-accent-text">{fmtMoney(item.amount)}</span>}</div>
        <div className="text-right text-xs text-muted">{statuses[item.status] && <p className="mb-1 font-semibold">{statuses[item.status]}</p>}<time dateTime={item.at}>{fmtDateTime(item.at, timezone)}</time></div>
      </li>)}
    </ol>
    {q.hasNextPage && <div className="border-t border-border p-4 text-center"><Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Carregar registros anteriores</Button></div>}
  </Card>;
}
