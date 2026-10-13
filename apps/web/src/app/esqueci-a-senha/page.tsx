'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.post('/auth/password/forgot', { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar.');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame title="Redefinir senha" subtitle="Enviaremos um link para o e-mail da sua conta.">
      {sent ? (
        <div className="space-y-4">
          <Notice tone="accent" icon={<MailCheck className="size-5" aria-hidden />} title="Verifique seu e-mail">
            Se houver uma conta com {email}, você receberá um link válido por 1 hora.
          </Notice>
          <Link href="/entrar" className="block text-center text-sm font-semibold text-primary-text hover:underline">
            Voltar para o login
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormError message={error} />
          <Field label="E-mail" required>
            {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" loading={pending} className="w-full">
            Enviar link
          </Button>
          <Link href="/entrar" className="block text-center text-sm text-muted hover:text-fg">
            Voltar
          </Link>
        </form>
      )}
    </AuthFrame>
  );
}
