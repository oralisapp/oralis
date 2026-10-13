'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { AuthFrame } from '@/components/auth-frame';
import { Button, ButtonLink } from '@/components/ui/button';
import { ErrorState, LoadingBlock, Notice } from '@/components/ui/feedback';
import { FormError } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { meQueryKey, useLogout, useMe } from '@/lib/session';

interface Preview {
  organizationName: string;
  roleName: string;
  email: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const logout = useLogout();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api.post<Preview>('/invitations/preview', { token }), retry: false });
  const accept = useMutation({
    mutationFn: () => api.post<{ organizationId: string }>('/invitations/accept', { token }),
    onSuccess: async (r) => {
      try {
        localStorage.setItem('oralis.activeOrg', r.organizationId);
      } catch {
        // opcional
      }
      await qc.invalidateQueries({ queryKey: meQueryKey });
      router.replace('/app/visao-geral');
    },
  });

  const here = `/convite/${token}`;
  let body;
  if (preview.isLoading || me.isLoading) body = <LoadingBlock rows={2} />;
  else if (preview.error) {
    body =
      preview.error instanceof ApiError && preview.error.status === 404 ? (
        <Notice tone="warning" title="Convite não encontrado">
          O link pode estar incompleto. Peça um novo convite a quem administra a clínica.
        </Notice>
      ) : (
        <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
      );
  } else if (preview.data) {
    const p = preview.data;
    const loggedEmail = me.data?.user.email;
    body = (
      <div className="space-y-5">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <MailCheck className="mb-3 size-6 text-primary" aria-hidden />
          <p className="text-[15px]">
            Você foi convidado(a) para <strong>{p.organizationName}</strong> com o papel <strong>{p.roleName}</strong>.
          </p>
          <p className="mt-1 text-sm text-muted">Convite enviado para {p.email}.</p>
        </div>
        {p.state !== 'pending' ? (
          <Notice tone="warning">
            {p.state === 'accepted' ? 'Este convite já foi aceito.' : p.state === 'expired' ? 'Este convite expirou. Peça um novo.' : 'Este convite foi cancelado pela clínica.'}
          </Notice>
        ) : loggedEmail === p.email ? (
          <>
            <FormError message={accept.error instanceof ApiError ? accept.error.message : null} />
            <Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
              Aceitar convite e entrar
            </Button>
          </>
        ) : loggedEmail ? (
          <div className="space-y-3">
            <Notice tone="warning">
              Você está conectado(a) como <strong>{loggedEmail}</strong>, mas o convite é para <strong>{p.email}</strong>.
            </Notice>
            <Button variant="secondary" className="w-full" onClick={logout}>
              Sair e usar outra conta
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <ButtonLink href={`/criar-conta?email=${encodeURIComponent(p.email)}&voltar=${encodeURIComponent(here)}`}>Criar minha conta</ButtonLink>
            <ButtonLink variant="secondary" href={`/entrar?voltar=${encodeURIComponent(here)}`}>
              Já tenho conta
            </ButtonLink>
          </div>
        )}
      </div>
    );
  }

  return <AuthFrame title="Convite para a equipe">{body}</AuthFrame>;
}
