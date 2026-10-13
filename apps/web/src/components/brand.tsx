'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="oralis-logo inline-flex items-center gap-2.5 font-extrabold tracking-tight text-fg">
      <svg viewBox="0 0 32 32" className="size-9" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--primary)" />
        <path d="M16 7c-5 0-8 3.4-8 8.2 0 5.6 3.9 9.8 8 9.8s8-4.2 8-9.8C24 10.4 21 7 16 7Z" fill="none" stroke="var(--on-primary)" strokeWidth="2.4" />
        <circle cx="16" cy="15.5" r="2.6" fill="var(--accent)" />
      </svg>
      {!compact && (
        <span className="text-[22px]">
          oralis<span className="ml-1 align-top text-[9px] font-semibold uppercase tracking-widest text-primary-text">cloud</span>
        </span>
      )}
    </span>
  );
}

type Theme = 'system' | 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const t = localStorage.getItem('oralis.theme');
      if (t === 'light' || t === 'dark') setTheme(t);
    } catch {
      // sem armazenamento local: segue o sistema
    }
  }, []);

  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const label: Record<Theme, string> = { system: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: escuro' };
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  function apply() {
    const t = next[theme];
    setTheme(t);
    try {
      if (t === 'system') {
        localStorage.removeItem('oralis.theme');
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem('oralis.theme', t);
        document.documentElement.dataset.theme = t;
      }
    } catch {
      if (t !== 'system') document.documentElement.dataset.theme = t;
    }
  }

  return (
    <button type="button" onClick={apply} aria-label={`${label[theme]}. Alternar tema`} title={label[theme]} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
      <Icon className="size-[18px]" aria-hidden />
    </button>
  );
}
