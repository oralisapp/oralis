'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/feedback';
import { FormError, Textarea } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrg } from '@/lib/session';
import type { Procedure } from './record-editor';

export interface ClinicalRecordView {
  id: string;
  status: 'draft' | 'finalized';
  content: string;
  procedures: Procedure[];
  createdAt: string;
  finalizedAt: string | null;
  contentHash: string | null;
  authorName: string;
  professionalName: string;
  croNumber: string | null;
  croUf: string | null;
  unitName: string;
  timezone: string;
  amendments: { id: string; content: string; createdAt: string; authorName: string; contentHash: string }[];
}

/** Registro finalizado: somente leitura, com autoria, hash e adendos em ordem. */
export function RecordView({ record, canAmend, compact = false }: { record: ClinicalRecordView; canAmend: boolean; compact?: boolean }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post(`/orgs/${orgId}/clinical-records/${record.id}/amendments`, { content: text }),
    onSuccess: async () => {
      setAdding(false);
      setText('');
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Erro ao salvar.'),
  });
  const tz = record.timezone;
  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-semibold text-fg">{fmtDateTime(record.finalizedAt ?? record.createdAt, tz)}</span>
        <span>· {record.professionalName}{record.croNumber ? ` (CRO ${record.croNumber}${record.croUf ? `/${record.croUf}` : ''})` : ''}</span>
        <span>· {record.unitName}</span>
        {record.status === 'finalized' ? <Badge tone="accent">Finalizado</Badge> : <Badge tone="warning">Rascunho</Badge>}
      </header>
      <p className={`whitespace-pre-wrap text-sm leading-relaxed ${compact ? 'line-clamp-6' : ''}`}>{record.content || '—'}</p>
      {record.procedures?.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-muted">
          {record.procedures.map((p, i) => <li key={i}>{p.description}{p.tooth ? ` — dente ${p.tooth}` : ''}{p.surfaces?.length ? ` (${p.surfaces.join(', ')})` : ''}</li>)}
        </ul>
      )}
      {record.contentHash && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-subtle" title={record.contentHash}>
          <Fingerprint className="size-3.5" aria-hidden /> Integridade: {record.contentHash.slice(0, 16)}… · autor {record.authorName}
        </p>
      )}
      {record.amendments.length > 0 && (
        <ol className="mt-3 space-y-2 border-l-2 border-warning/60 pl-3">
          {record.amendments.map((a) => (
            <li key={a.id} className="text-sm">
              <p className="text-xs font-semibold text-warning">Adendo · {fmtDateTime(a.createdAt, tz)} · {a.authorName}</p>
              <p className="whitespace-pre-wrap">{a.content}</p>
            </li>
          ))}
        </ol>
      )}
      {canAmend && record.status === 'finalized' && (
        <div className="mt-3">
          {!adding ? (
            <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Adicionar adendo</Button>
          ) : (
            <div className="space-y-2">
              <FormError message={error} />
              <Textarea aria-label="Texto do adendo" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="O registro original não será alterado; o adendo fica abaixo dele, com data e autoria." />
              <div className="flex gap-2">
                <Button size="sm" loading={add.isPending} disabled={text.trim().length < 3} onClick={() => add.mutate()}>Salvar adendo</Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancelar</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
