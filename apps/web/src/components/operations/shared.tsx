'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { useOrg } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, FormError } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

export function useOperation<T>(path: string, enabled = true) {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['org', orgId, 'operations', path], queryFn: () => api.get<T>(`/orgs/${orgId}${path}`), enabled });
}
export function TextField({ name, label, required, value, type = 'text', min, step, maxLength }: { name: string; label: string; required?: boolean; value?: string; type?: string; min?: string; step?: string; maxLength?: number }) {
  return <Field label={label} required={required}>{p => <Input {...p} name={name} defaultValue={value} type={type} min={min} step={step} maxLength={maxLength} />}</Field>;
}
export function Choice({ name, label, options, required = true, value }: { name: string; label: string; options: { id: string; name: string }[]; required?: boolean; value?: string }) {
  return <Field label={label} required={required}>{p => <Select {...p} name={name} defaultValue={value ?? ''}><option value="">Selecione…</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>;
}
export function OperationForm({ title, path, method = 'post', children, onClose, transform }: { title: string; path: string; method?: 'post' | 'put'; children: ReactNode; onClose: () => void; transform?: (data: Record<string, string>) => unknown }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({ mutationFn: (body: unknown) => api[method](`/orgs/${orgId}${path}`, body), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['org', orgId] }); toast({ tone: 'success', title: 'Registro salvo' }); onClose(); } });
  return <Dialog open onClose={() => !save.isPending && onClose()} title={title}><form className="space-y-4" onSubmit={e => { e.preventDefault(); const data = Object.fromEntries(Array.from(new FormData(e.currentTarget).entries()).filter(([, v]) => v !== '')) as Record<string, string>; save.mutate(transform ? transform(data) : data); }}>
    <FormError message={save.error instanceof ApiError ? [save.error.message, ...Object.values(save.error.fieldErrors)].join(' ') : save.error?.message} />
    <fieldset disabled={save.isPending} className="space-y-4">{children}</fieldset>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancelar</Button><Button type="submit" loading={save.isPending}>Salvar</Button></div>
  </form></Dialog>;
}
export const dateLabel = (date: string) => date.slice(0, 10).split('-').reverse().join('/');
