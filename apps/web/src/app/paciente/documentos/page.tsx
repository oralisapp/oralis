'use client';

import { useMutation } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, LoadingBlock } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePortalQuery } from '@/lib/portal';

export default function PortalDocuments() {
  const q = usePortalQuery<{ id: string; title: string; category: string; createdAt: string }[]>('documents', '/documents');
  const open = useMutation({ mutationFn: (id: string) => api.post<{ url: string }>(`/portal/documents/${id}/download`), onSuccess: (r) => window.open(r.url, '_blank', 'noopener') });
  if (q.isLoading) return <LoadingBlock rows={3} />;
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">Documentos e orientações</h1>
      <Card>
        {q.data?.length === 0 && <EmptyState icon={<FileText className="size-5" aria-hidden />} title="Nenhum documento disponível" description="A clínica decide quais documentos ficam disponíveis aqui." />}
        <ul className="divide-y divide-border">{q.data?.map((d) => <li key={d.id} className="flex items-center gap-3 px-5 py-3"><FileText className="size-5 text-subtle" aria-hidden /><span className="flex-1"><span className="font-semibold">{d.title}</span><span className="block text-xs text-muted">{fmtDateTime(d.createdAt, 'America/Sao_Paulo')}</span></span><Button size="sm" variant="secondary" icon={<Download className="size-4" aria-hidden />} loading={open.isPending && open.variables === d.id} onClick={() => open.mutate(d.id)}>Abrir</Button></li>)}</ul>
      </Card>
    </div>
  );
}
