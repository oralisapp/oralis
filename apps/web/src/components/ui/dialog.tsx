'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
  /** Painel lateral (detalhes) em vez de diálogo central. */
  side?: boolean;
}

/**
 * Usa o elemento <dialog> nativo: foco preso, Esc para fechar e restauração
 * do foco ao fechar são garantidos pelo navegador.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', side = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Foco inicial no primeiro campo do formulário, em vez do botão "Fechar".
      el.querySelector<HTMLElement>('[data-autofocus], form input:not([type=hidden]), form select, form textarea')?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const width = size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg';
  const placement = side
    ? 'ml-auto mr-0 my-0 h-dvh max-h-dvh w-full sm:max-w-md rounded-none sm:rounded-l-2xl'
    : `m-auto w-[calc(100%-2rem)] ${width} max-h-[calc(100dvh-2rem)] rounded-2xl`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`${placement} border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-transparent open:flex open:flex-col`}
    >
      {open && (
        <>
          <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <h2 id={titleId} className="text-base font-bold">
                {title}
              </h2>
              {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
            </div>
            <button type="button" onClick={onClose} aria-label="Fechar" className="-mr-2 rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
              <X className="size-5" aria-hidden />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}
