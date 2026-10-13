import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Oralis Cloud', template: '%s · Oralis Cloud' },
  description: 'Toda a sua clínica conectada. Mais tempo para cuidar.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f8f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0a1417' },
  ],
};

// Aplica o tema escolhido antes da pintura, evitando "piscar" o tema errado.
const themeScript = `try{var t=localStorage.getItem('oralis.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh font-sans text-[15px] leading-relaxed">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
