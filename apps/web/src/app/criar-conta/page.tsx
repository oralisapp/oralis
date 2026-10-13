'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { meQueryKey } from '@/lib/session';
import { safeReturn } from '@/lib/nav';

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const invitedEmail = params.get('email') ?? '';
  const [form, setForm] = useState({ name: '', email: invitedEmail, password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    setErrors({});
    try {
      await api.post('/auth/signup', form);
      await qc.invalidateQueries({ queryKey: meQueryKey });
      // Sem convite, o próximo passo é criar a clínica.
      const plan = params.get('plano');
      router.replace(safeReturn(params.get('voltar'), plan ? `/onboarding?plano=${encodeURIComponent(plan)}` : '/onboarding'));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(Object.keys(err.fieldErrors).length ? null : err.message);
      } else setError('Não foi possível criar a conta.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Seu nome" required error={errors.name}>
        {(p) => <Input {...p} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
      </Field>
      <Field label="E-mail" required error={errors.email} hint={invitedEmail ? 'E-mail do convite recebido.' : undefined}>
        {(p) => <Input {...p} type="email" autoComplete="email" value={form.email} readOnly={!!invitedEmail} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
      </Field>
      <Field label="Senha" required error={errors.password} hint="Ao menos 10 caracteres. Uma frase fácil de lembrar funciona bem.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Criar conta
      </Button>
      <p className="text-xs text-subtle">
        Termos de uso e política de privacidade estão em elaboração e passarão por revisão jurídica antes do lançamento. Não registre dados reais de pacientes neste ambiente.
      </p>
      <p className="text-center text-sm text-muted">
        Já tem conta?{' '}
        <Link href={`/entrar${params.get('voltar') ? `?voltar=${encodeURIComponent(params.get('voltar')!)}` : ''}`} className="font-semibold text-primary-text hover:underline">
          Entrar
        </Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <AuthFrame title="Criar conta" subtitle="Comece cadastrando quem é responsável pela clínica.">
      <Suspense>
        <SignupForm />
      </Suspense>
    </AuthFrame>
  );
}
