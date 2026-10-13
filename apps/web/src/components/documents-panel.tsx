'use client';

import { CSRF_HEADER } from '@oralis/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, EyeOff, FileText, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, FormError, Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';

export const DOC_CATEGORY = { exam: 'Exame', photo: 'Fotografia', clinical_document: 'Documento clínico', orientation: 'Orientação', consent: 'Termo/consentimento', administrative: 'Administrativo', other: 'Outro' } as const;

interface Doc {
  id: string;
  category: keyof typeof DOC_CATEGORY;
  title: string;
  currentVersion: number;
  sharedWithPatient: boolean;
  createdAt: string;
  createdByName: string | null;
  versions: { id: string; version: number; filename: string; sizeBytes: number }[];
}

/** Documentos do paciente: envio validado, versões, compartilhamento com o portal e download temporário. */
export function DocumentsPanel({ patientId, tz }: { patientId: string; tz: string }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useOrgQuery<Doc[]>(['documents', patientId], `/patients/${patientId}/documents`);
  const templates = useOrgQuery<{ id: string; name: string; active: boolean }[]>(['document-templates'], '/document-templates', can('clinical.read'));
  const fileRef = useRef<HTMLInputElement>(null);
  const clinical = can('clinical.write');
  const [f, setF] = useState({ category: clinical ? 'exam' : 'administrative', title: '', shared: false });
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'documents', patientId] });

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError('Selecione um arquivo.');
    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.set('category', f.category);
    fd.set('title', f.title || file.name);
    fd.set('sharedWithPatient', String(f.shared));
    fd.set('file', file);
    try {
      const res = await fetch(`/api/orgs/${orgId}/patients/${patientId}/documents`, { method: 'POST', body: fd, headers: { [CSRF_HEADER]: '1' } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body?.error?.code ?? 'internal_error', body?.error?.message ?? 'Falha no envio.');
      }
      toast({ tone: 'success', title: 'Documento enviado' });
      setF({ ...f, title: '' });
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha no envio.');
    } finally {
      setUploading(false);
    }
  }

  const open = useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/orgs/${orgId}/documents/${id}/download`, {}),
    onSuccess: (r) => window.open(r.url, '_blank', 'noopener'),
    onError: (err) => toast({ tone: 'error', title: 'Não foi possível abrir', description: err instanceof ApiError ? err.message : undefined }),
  });
  const share = useMutation({ mutationFn: (d: Doc) => api.put(`/orgs/${orgId}/documents/${d.id}`, { sharedWithPatient: !d.sharedWithPatient }), onSuccess: refresh });
  const gen = useMutation({
    mutationFn: (templateId: string) => api.post(`/orgs/${orgId}/patients/${patientId}/documents/from-template`, { templateId }),
    onSuccess: async () => { toast({ tone: 'success', title: 'Documento gerado a partir do modelo' }); await refresh(); },
  });

  return (
    <div className="space-y-4">
      {(can('patients.write') || clinical) && (
        <div className="space-y-3 rounded-xl border border-dashed border-border-strong p-4">
          <FormError message={error} />
          <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
            <Select aria-label="Categoria" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {Object.entries(DOC_CATEGORY).filter(([k]) => (k === 'administrative' ? can('patients.write') : clinical)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input aria-label="Título" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Título (opcional)" />
          </div>
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" aria-label="Arquivo" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-3 file:py-2 file:font-semibold file:text-primary-text" />
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox label="Disponibilizar no portal do paciente" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.target.checked })} />
            <Button size="sm" className="ml-auto" icon={<Upload className="size-4" aria-hidden />} loading={uploading} onClick={upload}>Enviar</Button>
          </div>
          <p className="text-xs text-subtle">PDF, JPG, PNG, WEBP ou TXT, até 15 MB. O tipo é conferido pelo conteúdo do arquivo.</p>
          {clinical && templates.data && templates.data.filter((t) => t.active).length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <span className="text-xs font-semibold text-muted">Gerar de modelo:</span>
              {templates.data.filter((t) => t.active).map((t) => <Button key={t.id} size="sm" variant="ghost" loading={gen.isPending && gen.variables === t.id} onClick={() => gen.mutate(t.id)}>{t.name}</Button>)}
            </div>
          )}
        </div>
      )}
      {q.isLoading && <LoadingBlock rows={2} />}
      {q.data && q.data.length === 0 && <EmptyState icon={<FileText className="size-5" aria-hidden />} title="Nenhum documento visível para o seu papel" />}
      <ul className="divide-y divide-border rounded-xl border border-border">
        {q.data?.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <FileText className="size-5 text-subtle" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{d.title}</p>
              <p className="text-xs text-muted">{DOC_CATEGORY[d.category]} · v{d.currentVersion} · {d.createdByName ?? '—'} · {fmtDateTime(d.createdAt, tz)}</p>
            </div>
            {d.sharedWithPatient && <Badge tone="info">No portal</Badge>}
            <Button size="sm" variant="ghost" icon={<Download className="size-4" aria-hidden />} loading={open.isPending && open.variables === d.id} onClick={() => open.mutate(d.id)}>Abrir</Button>
            {(d.category === 'administrative' ? can('patients.write') : clinical) && (
              <Button size="sm" variant="ghost" icon={d.sharedWithPatient ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />} onClick={() => share.mutate(d)}>
                {d.sharedWithPatient ? 'Tirar do portal' : 'Mostrar no portal'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
