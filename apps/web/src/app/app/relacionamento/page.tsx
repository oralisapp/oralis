'use client';

import { COMMUNICATION_CATEGORY_LABEL } from '@oralis/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Plus, Send, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RelationshipAttention } from '@/components/relationship-attention';
import { PatientPicker } from '@/components/new-appointment-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/feedback';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useOrg } from '@/lib/session';

const STAGES = [
  ['contact', 'Contato recebido'],
  ['evaluation_scheduled', 'Avaliação agendada'],
  ['evaluation_done', 'Avaliação realizada'],
  ['quote_sent', 'Orçamento enviado'],
  ['approved', 'Tratamento aprovado'],
  ['in_treatment', 'Em tratamento'],
  ['follow_up', 'Acompanhamento'],
] as const;
const SOURCES = { referral: 'Indicação', instagram: 'Instagram', google: 'Google', website: 'Site', walk_in: 'Passou na clínica', phone: 'Telefone', partnership: 'Parceria', other: 'Outro' } as const;
const STATUS: Record<string, { label: string; tone: 'accent' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  sent: { label: 'Enviada ao provedor', tone: 'accent' },
  logged_locally: { label: 'Caixa de saída local', tone: 'info' },
  queued: { label: 'Envio pendente de confirmação', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'danger' },
  not_configured: { label: 'Canal não configurado', tone: 'neutral' },
  blocked_consent: { label: 'Sem autorização', tone: 'neutral' },
  blocked_frequency: { label: 'Limite de frequência', tone: 'neutral' },
  blocked_demo: { label: 'Demonstração (não enviada)', tone: 'neutral' },
};

interface Lead { id: string; name: string; phone: string | null; source: keyof typeof SOURCES; stage: string; ownerName: string | null; patientId: string | null; stageChangedAt: string; lastInteraction: string | null }
interface Template { id: string; name: string; category: 'transactional' | 'relationship' | 'promotional'; channel: 'email' | 'sms' | 'whatsapp'; subject: string | null; body: string; version: number }

function Funnel() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ['org', orgId, 'crm-board'], queryFn: () => api.get<{ leads: Lead[]; counts: Record<string, number>; conversion: { total: number; won: number; rate: number | null; definition: string }; lostReasons: Record<string, number> }>(`/orgs/${orgId}/crm/board`) });
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'instagram', notes: '' });
  const [lost, setLost] = useState<{ id: string; reason: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', orgId, 'crm-board'] });
  const create = useMutation({ mutationFn: () => api.post(`/orgs/${orgId}/crm/leads`, Object.fromEntries(Object.entries(f).filter(([, v]) => v))), onSuccess: async () => { setCreating(false); setF({ name: '', phone: '', email: '', source: 'instagram', notes: '' }); await refresh(); } });
  const move = useMutation({ mutationFn: ({ id, stage, lostReason }: { id: string; stage: string; lostReason?: string }) => api.put(`/orgs/${orgId}/crm/leads/${id}/stage`, { stage, lostReason }), onSuccess: refresh });
  const convert = useMutation({ mutationFn: (id: string) => api.post<{ patientId: string }>(`/orgs/${orgId}/crm/leads/${id}/convert`), onSuccess: (r) => router.push(`/app/pacientes/${r.patientId}`) });
  if (q.isLoading) return <LoadingBlock rows={5} />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Card as="div" className="px-4 py-2 text-sm"><span className="text-muted">Conversão: </span><strong>{q.data.conversion.rate ?? '—'}%</strong> <span className="text-xs text-subtle" title={q.data.conversion.definition}>({q.data.conversion.won} de {q.data.conversion.total})</span></Card>
        {can('crm.write') && <Button className="ml-auto" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>Novo contato</Button>}
      </div>
      <p className="mb-3 text-xs text-subtle">{q.data.conversion.definition}</p>
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[1300px] grid-cols-7 gap-3">
          {STAGES.map(([key, label]) => (
            <section key={key} className="rounded-xl bg-surface-2 p-2" aria-label={`${label}: ${q.data!.counts[key] ?? 0}`}>
              <p className="mb-2 flex justify-between px-1 text-sm font-bold">{label}<span className="text-xs text-muted">{q.data!.counts[key] ?? 0}</span></p>
              <div className="space-y-2">
                {q.data!.leads.filter((l) => l.stage === key).map((l) => {
                  const idx = STAGES.findIndex((s) => s[0] === key);
                  return (
                    <div key={l.id} className="rounded-xl border border-border bg-surface p-3 text-sm shadow-card">
                      <p className="font-semibold">{l.name}</p>
                      <p className="text-xs text-muted">{SOURCES[l.source]}{l.phone ? ` · ${l.phone}` : ''}</p>
                      {can('crm.write') && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {idx < STAGES.length - 1 && <Button size="sm" variant="soft" onClick={() => move.mutate({ id: l.id, stage: STAGES[idx + 1]![0] })}>Avançar</Button>}
                          {!l.patientId ? <Button size="sm" variant="ghost" onClick={() => convert.mutate(l.id)}>Virar paciente</Button> : <Link href={`/app/pacientes/${l.patientId}`} className="px-2 py-1 text-xs font-semibold text-primary-text">Ficha</Link>}
                          <Button size="sm" variant="ghost" className="text-danger" onClick={() => setLost({ id: l.id, reason: '' })}>Perdido</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      {Object.keys(q.data.lostReasons).length > 0 && (
        <Card className="mt-4 p-5"><h2 className="mb-2 font-bold">Motivos de perda</h2><ul className="text-sm">{Object.entries(q.data.lostReasons).map(([r, n]) => <li key={r}>{r}: {n}</li>)}</ul></Card>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="Novo contato" footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button><Button loading={create.isPending} disabled={f.name.length < 2} onClick={() => create.mutate()}>Salvar</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome" required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Origem" required>{(p) => <Select {...p} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="Telefone">{(p) => <Input {...p} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <Field label="E-mail">{(p) => <Input {...p} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="Observação" className="sm:col-span-2" hint="Sem informações de saúde.">{(p) => <Textarea {...p} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        </div>
      </Dialog>
      <Dialog open={!!lost} onClose={() => setLost(null)} title="Marcar como perdido" footer={<><Button variant="ghost" onClick={() => setLost(null)}>Cancelar</Button><Button variant="danger" disabled={!lost?.reason} onClick={() => { move.mutate({ id: lost!.id, stage: 'lost', lostReason: lost!.reason }); setLost(null); }}>Confirmar</Button></>}>
        <Field label="Motivo" required>{(p) => <Select {...p} value={lost?.reason ?? ''} onChange={(e) => setLost({ ...lost!, reason: e.target.value })}><option value="">Selecione…</option>{['Preço', 'Escolheu outra clínica', 'Sem retorno', 'Distância/horário', 'Adiou o tratamento', 'Outro'].map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
      </Dialog>
    </>
  );
}

function Communications() {
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const { orgId, can, unit } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const events = useQuery({ queryKey: ['org', orgId, 'comm-events', category, status], queryFn: () => api.get<{ e: { id: string; channel: string; category: string; status: string; statusDetail: string | null; providerMessageId?: string | null; subject: string | null; body: string; createdAt: string }; patientName: string | null; sentByName: string | null; templateName: string | null }[]>(`/orgs/${orgId}/messaging/events?category=${category}&status=${status}`) });
  const templates = useQuery({ queryKey: ['org', orgId, 'templates'], queryFn: () => api.get<Template[]>(`/orgs/${orgId}/messaging/templates`) });
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [templateId, setTemplateId] = useState('');
  const preview = useQuery({ queryKey: ['org', orgId, 'preview', patient?.id, templateId], queryFn: () => api.post<{ subject: string | null; body: string; consent: boolean; channelConfigured: boolean }>(`/orgs/${orgId}/messaging/preview`, { patientId: patient!.id, templateId }), enabled: !!patient && !!templateId });
  const send = useMutation({ mutationFn: () => api.post<{ status: string }>(`/orgs/${orgId}/messaging/send`, { patientId: patient!.id, templateId }), onSuccess: async (r) => { toast({ tone: r.status === 'sent' || r.status === 'logged_locally' ? 'success' : 'error', title: STATUS[r.status]?.label ?? r.status }); await qc.invalidateQueries({ queryKey: ['org', orgId, 'comm-events'] }); }, onError: (e) => toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Não foi possível enviar a mensagem.' }) });
  return (
    <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
      {can('crm.write') && (
        <Card className="space-y-3 p-5">
          <h2 className="font-bold">Enviar mensagem</h2>
          <PatientPicker value={patient} onChange={setPatient} />
          <Select aria-label="Modelo" value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">Escolha o modelo…</option>{templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.channel})</option>)}</Select>
          {templates.error && <ErrorState error={templates.error} />}
          {preview.isFetching && <LoadingBlock rows={2} />}
          {preview.error && <ErrorState error={preview.error} />}
          {preview.data && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted">Mensagem final</p>
              <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-sm">{preview.data.subject ? `${preview.data.subject}\n\n` : ''}{preview.data.body}</pre>
              {!preview.data.consent && <Notice tone="warning">O paciente não autorizou este tipo de mensagem neste canal. Revise as preferências na ficha antes de enviar.</Notice>}
              {!preview.data.channelConfigured && <Notice tone="warning">Canal sem provedor configurado: nada será enviado.</Notice>}
              <Button icon={<Send className="size-4" aria-hidden />} loading={send.isPending} disabled={!preview.data.consent || !preview.data.channelConfigured || preview.isFetching} onClick={() => send.mutate()}>Enviar</Button>
            </div>
          )}
        </Card>
      )}
      <Card>
        <CardHeader title="Central de comunicações" description="Situação informada pelo provedor. Leitura não é exibida porque não é confirmada pelos provedores usados." />
        <div className="flex flex-wrap gap-2 border-b border-border p-4">
          <Select aria-label="Tipo de comunicação" value={category} onChange={(e) => setCategory(e.target.value)} className="!w-auto"><option value="">Todos os tipos</option><option value="transactional">Avisos do atendimento</option><option value="relationship">Relacionamento</option><option value="promotional">Campanhas</option></Select>
          <Select aria-label="Situação da comunicação" value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto"><option value="">Todas as situações</option>{Object.entries(STATUS).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        </div>
        {events.isLoading && <LoadingBlock />}
        {events.error && <ErrorState error={events.error} onRetry={() => events.refetch()} />}
        {events.data?.length === 0 && <EmptyState icon={<MessageSquare className="size-5" aria-hidden />} title="Nenhuma comunicação registrada" />}
        <ul className="divide-y divide-border">
          {events.data?.map(({ e, patientName, sentByName, templateName }) => (
            <li key={e.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{patientName ?? '—'}</span>
                <Badge>{e.channel}</Badge>
                <Badge tone="info">{COMMUNICATION_CATEGORY_LABEL[e.category as keyof typeof COMMUNICATION_CATEGORY_LABEL]?.split(' (')[0] ?? e.category}</Badge>
                <Badge tone={STATUS[e.status]?.tone ?? 'neutral'}>{STATUS[e.status]?.label ?? e.status}</Badge>
                <span className="ml-auto text-xs text-muted">{fmtDateTime(e.createdAt, unit?.timezone ?? 'America/Sao_Paulo')}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-muted">{e.body}</p>
              <p className="text-xs text-subtle">{templateName ? `Modelo: ${templateName} · ` : ''}{sentByName ? `por ${sentByName}` : 'automação'}{e.statusDetail ? ` · ${e.statusDetail}` : ''}</p>
              {e.providerMessageId && <p className="mt-1 break-all text-xs text-subtle">Protocolo no provedor: {e.providerMessageId}</p>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Templates() {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org', orgId, 'templates'], queryFn: () => api.get<Template[]>(`/orgs/${orgId}/messaging/templates`) });
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [f, setF] = useState({ name: '', category: 'relationship', channel: 'email', subject: '', body: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (editing && editing !== 'new' ? api.put(`/orgs/${orgId}/messaging/templates/${editing.id}`, { ...f, subject: f.subject || undefined }) : api.post(`/orgs/${orgId}/messaging/templates`, { ...f, subject: f.subject || undefined })),
    onSuccess: async () => { setEditing(null); await qc.invalidateQueries({ queryKey: ['org', orgId, 'templates'] }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro'),
  });
  const open = (t: Template | 'new') => { setEditing(t); setError(null); setF(t === 'new' ? { name: '', category: 'relationship', channel: 'email', subject: '', body: '' } : { name: t.name, category: t.category, channel: t.channel, subject: t.subject ?? '', body: t.body }); };
  return (
    <Card>
      <CardHeader title="Modelos de mensagem" description="Editar cria uma nova versão; o registro de cada envio guarda a versão usada." actions={can('crm.write') && <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => open('new')}>Novo modelo</Button>} />
      <ul className="divide-y divide-border">{q.data?.map((t) => <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm"><span className="flex-1"><span className="font-semibold">{t.name}</span> <span className="text-xs text-muted">v{t.version} · {t.channel} · {COMMUNICATION_CATEGORY_LABEL[t.category].split(' (')[0]}</span><span className="block truncate text-muted">{t.body}</span></span>{can('crm.write') && <Button size="sm" variant="ghost" onClick={() => open(t)}>Editar</Button>}</li>)}</ul>
      <Dialog open={!!editing} onClose={() => setEditing(null)} size="lg" title={editing === 'new' ? 'Novo modelo' : 'Editar modelo (nova versão)'} footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Salvar</Button></>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3"><FormError message={error} /></div>
          <Field label="Nome" required className="sm:col-span-3">{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Tipo" required>{(p) => <Select {...p} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="transactional">Aviso do atendimento</option><option value="relationship">Relacionamento</option><option value="promotional">Campanha</option></Select>}</Field>
          <Field label="Canal" required>{(p) => <Select {...p} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="email">E-mail</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></Select>}</Field>
          <Field label="Assunto">{(p) => <Input {...p} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />}</Field>
          <Field label="Texto" required className="sm:col-span-3" hint="Campos: {{primeiro_nome}} {{clinica}} {{data}} {{hora}} {{profissional}} {{link}}. Não inclua informações clínicas nem valores de dívida.">{(p) => <Textarea {...p} rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />}</Field>
        </div>
      </Dialog>
    </Card>
  );
}

function Campaigns() {
  const { orgId } = useOrg();
  const toast = useToast();
  const templates = useQuery({ queryKey: ['org', orgId, 'templates'], queryFn: () => api.get<Template[]>(`/orgs/${orgId}/messaging/templates`) });
  const [f, setF] = useState({ name: '', templateId: '', inactiveDays: '', pendingQuote: false });
  const criteria = { ...(f.inactiveDays ? { inactiveDays: Number(f.inactiveDays) } : {}), ...(f.pendingQuote ? { pendingQuote: true } : {}) };
  const [pv, setPv] = useState<{ matched: number; withConsent: number; withoutConsent: number; sampleRecipients: string[]; message: { subject: string | null; body: string } | null; channelConfigured: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useMutation({ mutationFn: () => api.post<NonNullable<typeof pv>>(`/orgs/${orgId}/messaging/campaigns/preview`, { templateId: f.templateId, criteria }), onSuccess: (r) => { setPv(r); setError(null); }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const send = useMutation({ mutationFn: () => api.post<{ result: Record<string, number> }>(`/orgs/${orgId}/messaging/campaigns`, { name: f.name, templateId: f.templateId, criteria, confirmRecipientCount: pv!.withConsent }), onSuccess: (r) => { toast({ tone: 'success', title: 'Campanha processada', description: Object.entries(r.result).map(([k, v]) => `${STATUS[k]?.label ?? k}: ${v}`).join(' · ') }); setPv(null); }, onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-bold">Nova campanha</h2>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome" required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Modelo" required>{(p) => <Select {...p} value={f.templateId} onChange={(e) => { setF({ ...f, templateId: e.target.value }); setPv(null); }}><option value="">Selecione…</option>{templates.data?.filter((t) => t.category !== 'transactional').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
        <Field label="Sem consulta concluída há (dias)">{(p) => <Input {...p} type="number" min={30} value={f.inactiveDays} onChange={(e) => { setF({ ...f, inactiveDays: e.target.value }); setPv(null); }} />}</Field>
        <div className="flex items-end"><Checkbox label="Somente com orçamento pendente" checked={f.pendingQuote} onChange={(e) => { setF({ ...f, pendingQuote: e.target.checked }); setPv(null); }} /></div>
      </div>
      <Button variant="secondary" disabled={!f.templateId} loading={preview.isPending} onClick={() => preview.mutate()}>Ver destinatários e mensagem</Button>
      {pv && (
        <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
          <p><strong>{pv.withConsent}</strong> destinatários com autorização · {pv.withoutConsent} sem autorização (não receberão) · {pv.matched} pelos critérios.</p>
          {pv.sampleRecipients.length > 0 && <p className="text-muted">Exemplos: {pv.sampleRecipients.join(', ')}</p>}
          {pv.message && <pre className="whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans">{pv.message.subject ? `${pv.message.subject}\n\n` : ''}{pv.message.body}</pre>}
          {!pv.channelConfigured && <Notice tone="warning">Canal sem provedor configurado: nada será enviado.</Notice>}
          <Button disabled={!f.name || pv.withConsent === 0 || !pv.channelConfigured} loading={send.isPending} onClick={() => send.mutate()}>Confirmar envio para {pv.withConsent} pessoa(s)</Button>
        </div>
      )}
    </Card>
  );
}

const TABS = [['atencao', 'Central de atenção'], ['funil', 'Funil'], ['comunicacoes', 'Comunicações'], ['modelos', 'Modelos'], ['campanhas', 'Campanhas']] as const;

function Inner() {
  const { can } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const visibleTabs = TABS.filter(([key]) => key !== 'campanhas' || can('crm.write'));
  const tab = visibleTabs.find((t) => t[0] === params.get('aba'))?.[0] ?? 'atencao';
  if (!can('crm.read')) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  return (
    <>
      <PageHeader title="Relacionamento" description="Funil de novos pacientes e comunicações, sempre respeitando as autorizações de cada pessoa." />
      <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">{visibleTabs.map(([k, l]) => <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => router.replace(`/app/relacionamento?aba=${k}`)} className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'border-primary text-primary-text' : 'border-transparent text-muted'}`}>{l}</button>)}</div>
      {tab === 'atencao' && <RelationshipAttention />}
      {tab === 'funil' && <Funnel />}
      {tab === 'comunicacoes' && <Communications />}
      {tab === 'modelos' && <Templates />}
      {tab === 'campanhas' && <Campaigns />}
    </>
  );
}

export default function RelationshipPage() {
  return <Suspense><Inner /></Suspense>;
}
