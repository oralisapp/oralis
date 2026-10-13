'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ClipboardList, FileText, Home, LogOut, Settings2, Wallet, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { PortalContext, type PortalMe } from '@/components/portal-context';
import { Logo, ThemeToggle } from '@/components/brand';
import { ApiError, api } from '@/lib/api';


const NAV = [
  { href: '/paciente/inicio', label: 'Início', icon: Home },
  { href: '/paciente/agendamentos', label: 'Consultas', icon: CalendarDays },
  { href: '/paciente/tratamentos', label: 'Tratamentos', icon: ClipboardList },
  { href: '/paciente/pagamentos', label: 'Pagamentos', icon: Wallet },
  { href: '/paciente/documentos', label: 'Documentos', icon: FileText },
  { href: '/paciente/formularios', label: 'Formulários', icon: ClipboardCheck },
  { href: '/paciente/preferencias', label: 'Preferências', icon: Settings2 },
];

/** Ambiente do paciente: acolhedor, enxuto e separado do ambiente da clínica. */
export default function PatientLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const isAccess = pathname === '/paciente/acesso';
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => api.get<PortalMe>('/portal/me'), enabled: !isAccess, retry: false });
  const unauth = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauth) router.replace('/paciente/acesso');
  }, [unauth, router]);

  if (isAccess) return <>{children}</>;
  if (!me.data) return <div className="flex min-h-dvh items-center justify-center"><div className="animate-pulse"><Logo /></div></div>;

  async function logout() {
    await api.post('/portal/logout').catch(() => {});
    qc.removeQueries({ queryKey: ['portal'] });
    router.replace('/paciente/acesso');
  }

  return (
    <PortalContext.Provider value={me.data}>
      <div className="min-h-dvh bg-bg">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
            <div>
              <p className="text-xs text-muted">Portal do paciente</p>
              <p className="font-extrabold">{me.data.clinic.name}</p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <button type="button" onClick={logout} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"><LogOut className="size-4" aria-hidden /> Sair</button>
            </div>
          </div>
          <nav aria-label="Portal" className="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-4">
            {NAV.map((n) => {
              const active = pathname === n.href;
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold ${active ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-fg'}`}>
                  <n.icon className="size-4" aria-hidden /> {n.label}
                </Link>
              );
            })}
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-4xl px-4 pb-8 text-xs text-subtle">
          Informações disponibilizadas pela clínica. Em caso de dúvida ou urgência, fale diretamente com a clínica{me.data.clinic.units[0]?.phone ? ` pelo telefone da unidade` : ''}. <Logo compact />
        </footer>
      </div>
    </PortalContext.Provider>
  );
}
