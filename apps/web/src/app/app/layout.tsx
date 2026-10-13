'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { Logo } from '@/components/brand';
import { ErrorState } from '@/components/ui/feedback';
import { ApiError } from '@/lib/api';
import { OrgProvider, useMe } from '@/lib/session';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  const noOrg = me.data && me.data.memberships.length === 0;

  useEffect(() => {
    if (unauthenticated) router.replace(`/entrar?voltar=${encodeURIComponent(pathname)}`);
    else if (noOrg) router.replace('/onboarding');
  }, [unauthenticated, noOrg, router, pathname]);

  if (me.data && !noOrg) {
    return (
      <OrgProvider me={me.data}>
        <AppShell>{children}</AppShell>
      </OrgProvider>
    );
  }
  if (me.error && !unauthenticated) {
    return (
      <div className="mx-auto max-w-md pt-24">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh items-center justify-center">
      <div className="animate-pulse">
        <Logo />
      </div>
      <span className="sr-only">Carregando sua clínica…</span>
    </div>
  );
}
