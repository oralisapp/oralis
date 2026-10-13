'use client';

import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { Logo } from '@/components/brand';
import { Card, EmptyState, ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface Msg {
  id: string;
  toAddress: string;
  subject: string;
  bodyText: string | null;
  createdAt: string;
}

/** Ferramenta de desenvolvimento: mostra os e-mails que seriam enviados quando não há SMTP. */
export default function OutboxPage() {
  const q = useQuery({ queryKey: ['outbox'], queryFn: () => api.get<{ smtpConfigured: boolean; messages: Msg[] }>('/dev/outbox'), refetchInterval: 5000 });
  const linkify = (text: string) =>
    text.split(/(https?:\/\/\S+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a key={i} href={part} className="break-all font-semibold text-primary-text underline">
          {part}
        </a>
      ) : (
        <span key={i}>{part}</span>
      ),
    );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Logo />
      <h1 className="mt-6 text-2xl font-extrabold">Caixa de saída local</h1>
      <div className="my-4">
        <Notice tone="warning">
          Ferramenta de desenvolvimento. Sem SMTP configurado, os e-mails não são enviados: ficam aqui para teste. Indisponível em homologação e produção.
        </Notice>
      </div>
      <Card>
        {q.isLoading && <LoadingBlock />}
        {q.error && <ErrorState error={q.error} />}
        {q.data && q.data.messages.length === 0 && <EmptyState icon={<Inbox className="size-5" aria-hidden />} title="Nenhum e-mail" />}
        <ul className="divide-y divide-border">
          {[...(q.data?.messages ?? [])].reverse().map((m) => (
            <li key={m.id} className="p-5">
              <p className="font-semibold">{m.subject}</p>
              <p className="text-xs text-muted">Para {m.toAddress} · {fmtDateTime(m.createdAt, 'America/Sao_Paulo')}</p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-sm">{linkify(m.bodyText ?? '')}</pre>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
