'use client';

import type { Permission } from '@oralis/shared';
import { MessageSquare, ArrowUpRight, Search, MapPin, Sparkles, Bell, ClipboardList, CalendarDays, CreditCard, Download, Route, Wallet, ChevronDown, FlaskConical, ShieldAlert, LayoutDashboard, LogOut, Menu, Settings, ShieldCheck, UserCog, UserRound, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTasks } from '@/lib/queries';
import { useLogout, useOrg } from '@/lib/session';
import { Logo, ThemeToggle } from './brand';
import { Dialog } from './ui/dialog';
import { Input } from './ui/field';
import { GlobalSearchResults } from './global-search-results';

interface NavItem {
  href: string;
  label: string;
  icon: typeof CalendarDays;
  anyOf?: Permission[];
}

/** Menu organizado por jornada. Só aparecem módulos implementados e permitidos. */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Dia a dia',
    items: [
      { href: '/app/visao-geral', label: 'Visão geral', icon: LayoutDashboard },
      { href: '/app/agenda', label: 'Agenda', icon: CalendarDays, anyOf: ['schedule.read'] },
      { href: '/app/pacientes', label: 'Pacientes', icon: Users, anyOf: ['patients.read'] },
      { href: '/app/tratamentos', label: 'Tratamentos', icon: Route, anyOf: ['treatments.read'] },
      { href: '/app/financeiro', label: 'Financeiro', icon: Wallet, anyOf: ['finance.read'] },
      { href: '/app/relacionamento', label: 'Relacionamento', icon: MessageSquare, anyOf: ['crm.read'] },
      { href: '/app/tarefas', label: 'Tarefas', icon: ClipboardList },
    ],
  },
  {
    group: 'Gestão',
    items: [
      { href: '/app/equipe', label: 'Equipe', icon: UserCog, anyOf: ['team.read'] },
      { href: '/app/estoque', label: 'Estoque', icon: ClipboardList, anyOf: ['inventory.read'] },
      { href: '/app/laboratorios', label: 'Laboratórios', icon: FlaskConical, anyOf: ['labs.read'] },
      { href: '/app/configuracoes', label: 'Configurações', icon: Settings, anyOf: ['units.manage', 'professionals.manage', 'resources.manage', 'services.manage'] },
      { href: '/app/auditoria', label: 'Auditoria', icon: ShieldCheck, anyOf: ['audit.read'] },
      { href: '/app/exportacoes', label: 'Exportações', icon: Download, anyOf: ['data.export'] },
      { href: '/app/assinatura', label: 'Assinatura', icon: CreditCard },
    ],
  },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can } = useOrg();
  return (
    <nav aria-label="Principal" className="flex flex-col gap-7">
      {NAV.map((g) => {
        const items = g.items.filter((i) => !i.anyOf || i.anyOf.some(can));
        if (!items.length) return null;
        return (
          <div key={g.group}>
            <p className="nav-caption mb-3 px-3">{g.group}</p>
            <ul className="flex flex-col gap-1">
              {items.map((i) => {
                const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className="nav-link"
                    >
                      <i.icon className="size-[18px]" aria-hidden />
                      {i.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NavigationSearch() {
  const { can } = useOrg();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(v => !v); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const normalize = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const items = NAV.flatMap(g => g.items).filter(i => (!i.anyOf || i.anyOf.some(can)) && normalize(i.label).includes(normalize(search)));
  return <>
    <button type="button" onClick={() => { setSearch(''); setOpen(true); }} aria-label="Buscar uma área da plataforma" className="flex h-10 items-center gap-2 rounded-xl border border-border bg-bg/70 px-3 text-sm text-muted transition hover:border-border-strong">
      <Search className="size-4" aria-hidden /><span className="hidden xl:inline">Ir para...</span><kbd className="ml-6 hidden rounded border border-border bg-surface px-1.5 text-[10px] xl:inline">Ctrl K</kbd>
    </button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Aonde vamos?" description="Encontre pacientes, consultas e áreas da sua clínica.">
      <div className="relative mb-4"><Search className="absolute left-3 top-3.5 size-4 text-muted" aria-hidden /><Input data-autofocus aria-label="Buscar área" placeholder="Nome, telefone, CPF ou uma área..." maxLength={100} value={search} onChange={e => setSearch(e.target.value)} className="pl-10" /></div>
      <div className="max-h-[60dvh] overflow-y-auto">
      <GlobalSearchResults search={search} open={open} onNavigate={() => setOpen(false)} />
      <nav aria-label="Resultados da busca" className="space-y-1">
        {items.map(i => <Link key={i.href} href={i.href} onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm hover:bg-primary-soft focus:bg-primary-soft"><i.icon className="size-4 text-primary" aria-hidden />{i.label}<ArrowUpRight className="ml-auto size-4 text-muted" aria-hidden /></Link>)}
        {!items.length && <p className="py-8 text-center text-sm text-muted">Nenhuma área encontrada. Tente outro nome.</p>}
      </nav>
      </div>
    </Dialog>
  </>;
}

/** Contador de tarefas abertas para a pessoa e seu papel. */
function TasksBell() {
  const q = useTasks('mine', 'open');
  const n = q.data?.length ?? 0;
  return (
    <Link href="/app/tarefas" aria-label={`Tarefas: ${n} abertas`} title="Tarefas" className="relative inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
      <Bell className="size-[18px]" aria-hidden />
      {n > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-4 text-white">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}

function UserMenu() {
  const { me, membership } = useOrg();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Abrir opções da conta" className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-on-primary">
          {me.user.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
        </span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-40 truncate text-sm font-semibold">{me.user.name}</span>
          <span className="block text-xs text-muted">{membership.role.name}</span>
        </span>
        <ChevronDown className="size-4 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="animate-rise absolute right-0 z-40 mt-1 w-56 rounded-xl border border-border bg-surface p-1 shadow-pop">
          <Link href="/app/conta" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
            <UserRound className="size-4" aria-hidden /> Minha conta e sessões
          </Link>
          <button type="button" onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-soft">
            <LogOut className="size-4" aria-hidden /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

function ContextSelectors() {
  const { me, membership, unit, setUnitId, switchOrg } = useOrg();
  return (
    <div className="flex min-w-0 items-center gap-2">
      {me.memberships.length > 1 ? (
        <select aria-label="Organização" value={membership.organizationId} onChange={(e) => switchOrg(e.target.value)} className="h-9 min-w-0 max-w-44 truncate rounded-lg border border-border bg-surface px-2 text-sm font-semibold">
          {me.memberships.map((m) => (
            <option key={m.organizationId} value={m.organizationId}>
              {m.organizationName}
            </option>
          ))}
        </select>
      ) : (
        <span className="max-w-32 truncate text-xs font-bold sm:max-w-52 sm:text-sm">{membership.organizationName}</span>
      )}
      {membership.units.length > 1 && unit && (
        <select aria-label="Unidade" value={unit.id} onChange={(e) => setUnitId(e.target.value)} className="h-9 min-w-0 max-w-40 truncate rounded-lg border border-border bg-surface px-2 text-sm">
          {membership.units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      {membership.units.length === 1 && unit && <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted"><MapPin className="size-3" aria-hidden />{unit.name}</span>}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { membership } = useOrg();
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const appEnv = process.env.NEXT_PUBLIC_APP_ENV ?? 'development';

  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const el = drawerRef.current;
    if (!el) return;
    if (drawer && !el.open) el.showModal();
    if (!drawer && el.open) el.close();
    if (!drawer) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const media = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (media.matches) setDrawer(false); };
    media.addEventListener('change', closeOnDesktop);
    return () => { document.body.style.overflow = previous; media.removeEventListener('change', closeOnDesktop); };
  }, [drawer]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#conteudo" className="skip-link">Pular para o conteúdo</a>
      {appEnv !== 'production' && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 bg-warning-soft px-4 py-1 text-center text-[10px] font-medium text-warning">
          <FlaskConical className="size-3.5" aria-hidden />
          Ambiente de {appEnv === 'development' ? 'desenvolvimento' : appEnv === 'staging' ? 'homologação' : 'teste'} — não registre dados reais de pacientes.
          {appEnv !== 'staging' && (
            <Link href="/dev/caixa-de-saida" className="underline underline-offset-2">
              Caixa de saída local
            </Link>
          )}
        </div>
      )}
      {membership.subscription.access === 'read_only' && (
        <div role="alert" className="bg-danger-soft px-4 py-1.5 text-center text-xs font-semibold text-danger">
          Modo somente leitura: {membership.subscription.accessReason} Consulte e exporte os dados; para voltar a registrar, <Link href="/app/assinatura" className="underline">regularize a assinatura</Link>.
        </div>
      )}
      {membership.subscription.status === 'trial' && membership.subscription.trialEndsAt && membership.subscription.access === 'full' && (
        <div className="bg-primary-soft px-4 py-1 text-center text-xs font-semibold text-primary-text">
          Avaliação do plano {membership.subscription.planName} até {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(membership.subscription.trialEndsAt))}. <Link href="/app/assinatura" className="underline">Ver assinatura</Link>
        </div>
      )}
      {membership.isDemo && (
        <div className="bg-info-soft px-4 py-1 text-center text-xs font-semibold text-info-text">Organização de demonstração: todos os dados são fictícios e nenhuma mensagem é enviada.</div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="sidebar sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col overflow-y-auto px-4 py-7 lg:flex">
          <Link href="/app/visao-geral" className="mb-10 px-3">
            <Logo />
          </Link>
          <NavLinks />
          <div className="mt-auto pt-9">
            <div className="sidebar-footer rounded-2xl p-4">
              <Sparkles className="mb-3 size-5 text-[#d7edaa]" aria-hidden />
              <p className="font-display text-xl text-[#edf3e6]">Mais tempo<br />para cuidar.</p>
              <p className="mt-2 text-[11px] leading-relaxed text-[#b0c4b6]">Sua clínica, em sintonia.</p>
              <Link href="/app/assinatura" className="mt-4 flex items-center justify-between text-xs font-semibold text-[#d7edaa]">Meu plano<ArrowUpRight className="size-3.5" aria-hidden /></Link>
            </div>
            <p className="mt-5 px-3 text-[9px] uppercase tracking-[.2em] text-[#a4bbac]">Oralis · Gestão odontológica</p>
          </div>
        </aside>

        <dialog ref={drawerRef} aria-label="Menu principal" onCancel={e => { e.preventDefault(); setDrawer(false); }} onClick={e => { if (e.target === e.currentTarget) setDrawer(false); }} className="sidebar fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-72 max-w-[88vw] border-0 p-0 shadow-pop">
          <div className="flex min-h-full flex-col px-4 py-6">
            <div className="mb-8 flex items-center justify-between px-2"><Logo /><button type="button" onClick={() => setDrawer(false)} aria-label="Fechar menu" className="rounded-lg p-2 text-[#d7edaa]"><X className="size-5" aria-hidden /></button></div>
            <NavLinks onNavigate={() => setDrawer(false)} />
          </div>
        </dialog>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center sm:h-[76px] gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur sm:px-7">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Abrir menu" className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-surface-2 lg:hidden">
              <Menu className="size-5" aria-hidden />
            </button>
            <span className="lg:hidden">
              <Logo compact />
            </span>
            <div className="hidden min-w-0 sm:block"><ContextSelectors /></div>
            <div className="ml-auto flex items-center gap-1">
              <NavigationSearch />
              <TasksBell />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <div className="flex border-b border-border bg-surface px-4 py-2.5 sm:hidden"><ContextSelectors /></div>
          <main id="conteudo" className="workspace-main mx-auto w-full max-w-[1560px] flex-1 px-4 py-6 sm:px-7 lg:px-9 lg:py-8">
            {membership.mfaRequired && pathname !== '/app/conta' ? (
              <div className="mx-auto max-w-lg rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
                <ShieldAlert className="mx-auto mb-3 size-8 text-warning" aria-hidden />
                <h1 className="text-xl font-bold">Ative a verificação em duas etapas</h1>
                <p className="mt-2 text-muted">{membership.organizationName} exige MFA para o papel {membership.role.name}. Leva um minuto com um aplicativo autenticador.</p>
                <Link href="/app/conta" className="mt-5 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary">
                  Ativar agora
                </Link>
              </div>
            ) : (
              children
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
