import { AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from './button';

export function Card({ children, className = '', as: Tag = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <Tag className={`oralis-card rounded-2xl border border-border bg-surface shadow-card ${className}`}>{children}</Tag>;
}

export function CardHeader({ title, description, actions, icon }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="flex items-start gap-3">
        {icon && <span className="mt-0.5 text-primary">{icon}</span>}
        <div>
          <h2 className="text-[15px] font-bold">{title}</h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="page-heading mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary-text">{eyebrow}</div>}
        <h1 className="font-display text-3xl tracking-tight sm:text-[38px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'primary' | 'accent' | 'warning' | 'danger' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-muted',
  primary: 'bg-primary-soft text-primary-text',
  accent: 'bg-accent-soft text-accent-text',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info-text',
};

export function Badge({ tone = 'neutral', children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-surface-3 ${className}`} />;
}

export function LoadingBlock({ label = 'Carregando…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 p-5">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary-text">{icon}</div>
      <h3 className="font-bold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Estado de erro com distinção entre "sem permissão" e falha técnica. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const isForbidden = error instanceof ApiError && (error.status === 403 || error.code === 'forbidden');
  if (isForbidden) {
    return (
      <EmptyState
        icon={<Lock className="size-5" aria-hidden />}
        title="Você não tem acesso a esta área"
        description="Seu papel na equipe não inclui esta permissão. Se precisar, peça ao responsável pela clínica."
      />
    );
  }
  const message = error instanceof ApiError ? error.message : 'Não foi possível carregar os dados.';
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <AlertTriangle className="mb-2 size-6 text-warning" aria-hidden />
      <p className="font-semibold">Algo deu errado</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {error instanceof ApiError && error.requestId && <p className="mt-2 break-all text-[10px] text-subtle">Referência para suporte: {error.requestId}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry} icon={<RefreshCw className="size-3.5" aria-hidden />}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, icon }: { tone?: Tone; title?: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`flex gap-3 rounded-xl px-4 py-3 text-sm ${tones[tone]}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div>
        {title && <p className="font-semibold">{title}</p>}
        <div className={title ? 'opacity-90' : ''}>{children}</div>
      </div>
    </div>
  );
}
