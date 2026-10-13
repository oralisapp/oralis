'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, ErrorState, LoadingBlock, Notice, PageHeader } from '@/components/ui/feedback';
import { Field, FormError, Input } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { meQueryKey, useOrg } from '@/lib/session';

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function device(ua: string | null): string {
  if (!ua) return 'Dispositivo desconhecido';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => api.post('/auth/password/change', form),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Senha alterada', description: 'As outras sessões foram encerradas.' });
      setForm({ currentPassword: '', newPassword: '' });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(Object.keys(err.fieldErrors).length ? null : err.message);
      }
    },
  });
  return (
    <Card>
      <CardHeader icon={<KeyRound className="size-5" aria-hidden />} title="Senha" description="Ao trocar a senha, os outros dispositivos precisam entrar de novo." />
      <form
        className="grid gap-4 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setErrors({});
          setError(null);
          change.mutate();
        }}
      >
        <div className="sm:col-span-3"><FormError message={error} /></div>
        <Field label="Senha atual" required error={errors.currentPassword}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />}
        </Field>
        <Field label="Nova senha" required error={errors.newPassword}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />}
        </Field>
        <Button type="submit" loading={change.isPending}>Alterar</Button>
      </form>
    </Card>
  );
}

function MfaCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api.get<{ enabled: boolean; recoveryCodesLeft: number }>('/auth/mfa') });
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, setDisable] = useState({ open: false, password: '', code: '' });
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['mfa'] });
    await qc.invalidateQueries({ queryKey: meQueryKey });
  };
  const start = useMutation({ mutationFn: () => api.post<{ secret: string; qrSvg: string }>('/auth/mfa/setup'), onSuccess: (r) => { setSetup(r); setError(null); } });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: async (r) => {
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Código inválido.'),
  });
  const off = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password: disable.password, code: disable.code }),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Verificação em duas etapas desativada' });
      setDisable({ open: false, password: '', code: '' });
      await refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Não foi possível desativar.'),
  });

  return (
    <Card>
      <CardHeader
        icon={<ShieldCheck className="size-5" aria-hidden />}
        title="Verificação em duas etapas"
        description="Além da senha, um código do aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…)."
        actions={status.data && (status.data.enabled ? <Badge tone="accent">Ativa</Badge> : <Badge tone="warning">Desativada</Badge>)}
      />
      <div className="space-y-4 p-5">
        <FormError message={error} />
        {status.isLoading && <LoadingBlock rows={1} />}
        {codes && (
          <Notice tone="warning" title="Guarde estes códigos de recuperação agora">
            <p className="mb-2">Cada um funciona uma vez, caso você perca o celular. Eles não serão exibidos novamente.</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">
              {codes.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setCodes(null)}>Já guardei</Button>
          </Notice>
        )}
        {status.data && !status.data.enabled && !setup && (
          <Button onClick={() => start.mutate()} loading={start.isPending}>Ativar</Button>
        )}
        {setup && (
          <div className="grid gap-5 sm:grid-cols-[220px_1fr]">
            <div className="rounded-xl bg-white p-2" aria-label="QR code para o aplicativo autenticador" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
            <div className="space-y-3 text-sm">
              <p>1. Leia o QR code com o aplicativo autenticador. Sem câmera? Digite a chave:</p>
              <code className="block break-all rounded-lg bg-surface-2 px-3 py-2 font-mono">{setup.secret}</code>
              <p>2. Digite o código de 6 dígitos que aparece no aplicativo:</p>
              <div className="flex gap-2">
                <Input aria-label="Código do aplicativo" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" className="max-w-40" />
                <Button onClick={() => enable.mutate()} loading={enable.isPending}>Confirmar</Button>
              </div>
            </div>
          </div>
        )}
        {status.data?.enabled && !disable.open && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{status.data.recoveryCodesLeft} códigos de recuperação disponíveis.</span>
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDisable({ ...disable, open: true })}>Desativar</Button>
          </div>
        )}
        {disable.open && (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Senha" required>{(p) => <Input {...p} type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} />}</Field>
            <Field label="Código atual" required>{(p) => <Input {...p} inputMode="numeric" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} />}</Field>
            <Button variant="danger" loading={off.isPending} onClick={() => off.mutate()}>Desativar</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function AccountPage() {
  const { me, unit } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Sessão encerrada', description: 'O dispositivo precisará entrar novamente.' });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const tz = unit?.timezone ?? 'America/Sao_Paulo';

  return (
    <>
      <PageHeader title="Minha conta" description={`${me.user.name} · ${me.user.email}`} />
      <div className="space-y-6">
        <MfaCard />
        <PasswordCard />
        <Card>
          <CardHeader icon={<Laptop className="size-5" aria-hidden />} title="Sessões ativas" description="Encerre o acesso de dispositivos que você não reconhece ou não usa mais." />
          {sessions.isLoading && <LoadingBlock />}
          {sessions.error && <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />}
          <ul className="divide-y divide-border">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {device(s.userAgent)} {s.current && <Badge tone="accent">Esta sessão</Badge>}
                  </p>
                  <p className="text-sm text-muted">
                    Início {fmtDateTime(s.createdAt, tz)} · última atividade {fmtDateTime(s.lastSeenAt, tz)}
                    {s.ip ? ` · IP ${s.ip}` : ''}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="secondary" size="sm" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                    Encerrar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
