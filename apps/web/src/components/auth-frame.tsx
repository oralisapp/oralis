import { ArrowUpRight, CalendarCheck2, ShieldCheck, Sparkles, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo, ThemeToggle } from './brand';

/** Identidade compartilhada entre entrada, cadastro e recuperação de acesso. */
export function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1fr]">
      <aside className="auth-story relative hidden min-h-dvh flex-col overflow-hidden px-12 py-10 lg:flex xl:px-16">
        <div className="flex items-center justify-between"><Logo /><span className="rounded-full border border-white/20 px-3 py-1 text-[9px] uppercase tracking-[.15em] text-[#cfdec7]">Feito para cuidar</span></div>
        <div className="my-auto py-10">
          <p className="mb-5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-[#d7edaa]"><span className="size-1.5 rounded-full bg-[#d7edaa]" />Sua clínica. Em sintonia.</p>
          <h1 className="font-display max-w-lg text-[clamp(42px,4.2vw,66px)] leading-[1.08]">A gestão flui.<br />O cuidado<br /><em className="text-[#d7edaa]">acontece.</em></h1>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-[#c0d1c1]">Agenda, equipe e pacientes conectados. Para você dedicar seu tempo ao que faz a diferença.</p>
          <div className="relative mx-auto mt-8 flex max-w-md justify-center" aria-hidden>
            <div className="auth-orbit"><span className="orbit-core">o.</span><span className="orbit-label -left-1 top-[22%]"><CalendarCheck2 className="size-4 text-[#d7edaa]" />Agenda organizada</span><span className="orbit-label -right-1 bottom-[24%]"><Users className="size-4 text-[#d7edaa]" />Cuidado conectado</span><span className="absolute right-[20%] top-[3%] size-3 rounded-full bg-[#d7edaa]" /></div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-white/15 pt-5 text-[10px] text-[#c0d1c1]"><span>Menos complexidade. Mais presença.</span><Sparkles className="size-4 text-[#d7edaa]" aria-hidden /></div>
      </aside>
      <main className="relative flex min-h-dvh flex-col bg-bg px-6 py-7 sm:px-12">
        <div className="flex items-center justify-between"><span className="lg:hidden"><Logo /></span><span className="ml-auto"><ThemeToggle /></span></div>
        <div className="mx-auto my-auto w-full max-w-[390px] py-12">
          <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-border bg-surface text-primary shadow-card"><ArrowUpRight className="size-6" aria-hidden /></div>
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[.2em] text-muted">Seu próximo cuidado começa aqui</p>
          <h2 className="font-display text-[42px] leading-tight">{title}</h2>
          {subtitle && <p className="mt-3 text-sm leading-relaxed text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          <p className="mt-9 flex items-center justify-center gap-2 border-t border-border pt-6 text-[11px] text-muted"><ShieldCheck className="size-3.5" aria-hidden />Seu espaço de trabalho, protegido.</p>
        </div>
        <p className="text-center text-[10px] text-muted">Oralis Cloud · Mais tempo para cuidar.</p>
      </main>
    </div>
  );
}
