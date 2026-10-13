'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button, ButtonLink } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível redefinir.');
    } finally {
      setPending(false);
    }
  }

  if (!token) return <Notice tone="warning">Link incompleto. Peça um novo em <Link href="/esqueci-a-senha" className="underline">Esqueci a senha</Link>.</Notice>;
  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="accent" title="Senha alterada">Por segurança, todas as sessões abertas foram encerradas.</Notice>
        <ButtonLink href="/entrar" className="w-full">Entrar</ButtonLink>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Nova senha" required hint="Ao menos 10 caracteres.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Field label="Repita a nova senha" required>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Salvar nova senha
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthFrame title="Criar nova senha">
      <Suspense>
        <ResetForm />
      </Suspense>
    </AuthFrame>
  );
}
