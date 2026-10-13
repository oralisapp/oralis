'use client';

import { useEffect } from 'react';

/** Capture links and workspace tabs before React navigation unmounts an editor. */
export function UnsavedGuard() {
  useEffect(() => {
    const guard = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href], [role="tab"]') : null;
      if (!target || !document.querySelector('[data-unsaved="true"]')) return;
      if (target instanceof HTMLAnchorElement && (target.target === '_blank' || event.ctrlKey || event.metaKey)) return;
      if (!window.confirm('Há alterações ainda não salvas. Sair e manter a cópia de recuperação neste navegador?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('click', guard, true);
    return () => document.removeEventListener('click', guard, true);
  }, []);
  return null;
}
