'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Notice, PageHeader } from '@/components/ui/feedback';
import { Checkbox, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrg } from '@/lib/session';

interface ExportRow { id: string; scope: string; status: 'queued' | 'ready' | 'failed' | 'expired'; filename: string | null; rowCount: number | null; createdAt: string; expiresAt: string | null; requestedByName: string; error: string | null }

/** Exportação controlada: escopo, confirmação de responsabilidade, fila e arquivo que expira. */
export default function ExportsPage() {
  const { orgId, can, membership } = useOrg();
  const allowed = can('data.export') && membership.allUnits;
  const qc = useQueryClient();
  const toast = useToast();
  const scopes = useQuery({ queryKey: ['org', orgId, 'export-scopes'], queryFn: () => api.get<Record<string, string>>(`/orgs/${orgId}/exports/scopes`), enabled: allowed });
  const list = useQuery({ queryKey: ['org', orgId, 'exports'], queryFn: () => api.get<ExportRow[]>(`/orgs/${orgId}/exports`), enabled: allowed, refetchInterval: (q) => (q.state.data?.some((e) => e.status === 'queued') ? 3000 : false) });
  const [scope, setScope] = useState('patients');
  const [ack, setAck] = useState(false);
  const request = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/exports`, { scope }),
    onSuccess: async () => { toast({ tone: 'success', title: 'Exportação solicitada', description: 'O arquivo fica pronto em instantes e expira em 24 horas.' }); setAck(false); await qc.invalidateQueries({ queryKey: ['org', orgId, 'exports'] }); },
    onError: (e) => toast({ tone: 'error', title: 'Não foi possível exportar', description: e instanceof ApiError ? e.message : undefined }),
  });
  if (!can('data.export')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  if (!membership.allUnits) return <><PageHeader title="Exportação de dados" description="Os arquivos reúnem dados de todas as unidades da organização." /><Notice tone="info">Seu acesso está limitado a unidades específicas. Para obter uma exportação, solicite o arquivo a um responsável com acesso a toda a organização.</Notice></>;
  const tz = 'America/Sao_Paulo';
  return (
    <>
      <PageHeader title="Exportação de dados" description="Planilhas (CSV) com os dados da organização. Disponível mesmo com a assinatura suspensa ou cancelada." />
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <Card className="space-y-4 p-5">
          <h2 className="font-bold">Nova exportação</h2>
          <Select aria-label="O que exportar" value={scope} onChange={(e) => setScope(e.target.value)}>{scopes.data && Object.entries(scopes.data).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Notice tone="warning">O arquivo contém dados pessoais. Quem baixa passa a ser responsável por guardá-lo com segurança e usá-lo apenas para finalidades legítimas. A exportação fica registrada na auditoria.</Notice>
          <Checkbox label="Entendo e assumo a responsabilidade pelo arquivo" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <Button icon={<FileDown className="size-4" aria-hidden />} disabled={!ack} loading={request.isPending} onClick={() => request.mutate()}>Gerar arquivo</Button>
          <p className="text-xs text-muted">Documentos clínicos (exames, fotos) são baixados individualmente na ficha do paciente. Pacote completo de documentos depende de projeto específico.</p>
        </Card>
        <Card>
          <CardHeader title="Arquivos gerados" />
          {list.data?.length === 0 && <EmptyState icon={<Download className="size-5" aria-hidden />} title="Nenhuma exportação ainda" />}
          <ul className="divide-y divide-border">
            {list.data?.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="flex-1"><p className="font-semibold">{scopes.data?.[e.scope] ?? e.scope}</p><p className="text-xs text-muted">{e.requestedByName} · {fmtDateTime(e.createdAt, tz)}{e.rowCount !== null ? ` · ${e.rowCount} linhas` : ''}{e.expiresAt && e.status === 'ready' ? ` · expira ${fmtDateTime(e.expiresAt, tz)}` : ''}</p></div>
                <Badge tone={e.status === 'ready' ? 'accent' : e.status === 'queued' ? 'info' : 'neutral'}>{{ queued: 'Processando', ready: 'Pronto', failed: 'Falhou', expired: 'Expirado' }[e.status]}</Badge>
                {e.status === 'ready' && <a href={`/api/orgs/${orgId}/exports/${e.id}/download`} className="inline-flex items-center gap-1 font-semibold text-primary-text hover:underline"><Download className="size-4" aria-hidden /> Baixar</a>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
