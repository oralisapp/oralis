'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { safeReturn } from '@/lib/nav';
import { meQueryKey } from '@/lib/session';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function finish() {
    await qc.invalidateQueries({ queryKey: meQueryKey });
    router.replace(safeReturn(params.get('voltar')));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (challenge) {
        await api.post('/auth/login/mfa', { challengeToken: challenge, code });
        await finish();
        return;
      }
      const r = await api.post<{ ok?: boolean; mfaRequired?: boolean; challengeToken?: string }>('/auth/login', { email, password });
      if (r.mfaRequired && r.challengeToken) {
        setChallenge(r.challengeToken);
        setPending(false);
        return;
      }
      await finish();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPending(false);
    }
  }

  const signupHref = `/criar-conta${params.get('voltar') ? `?voltar=${encodeURIComponent(params.get('voltar')!)}` : ''}`;

  if (challenge) {
    return (
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex items-start gap-3 rounded-xl bg-primary-soft p-4 text-sm text-primary-text">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>Digite o código de 6 dígitos do seu aplicativo autenticador. Se perdeu o celular, use um dos códigos de recuperação.</p>
        </div>
        <FormError message={error} />
        <Field label="Código" required>
          {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" />}
        </Field>
        <Button type="submit" loading={pending} className="w-full">
          Confirmar
        </Button>
        <button type="button" className="w-full text-center text-sm text-muted hover:text-fg" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>
          Voltar
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="E-mail" required>
        {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label="Senha" required>
        {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <div className="text-right">
        <Link href="/esqueci-a-senha" className="text-sm font-semibold text-primary-text hover:underline">
          Esqueci a senha
        </Link>
      </div>
      <Button type="submit" loading={pending} className="w-full">
        Entrar
      </Button>
      <p className="text-center text-sm text-muted">
        Ainda não tem conta?{' '}
        <Link href={signupHref} className="font-semibold text-primary-text underline-offset-2 hover:underline">
          Criar conta
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthFrame title="Entrar" subtitle="Acesse a sua clínica.">
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthFrame>
  );
}
