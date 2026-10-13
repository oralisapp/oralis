import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Na Vercel não existe API local: sem API_INTERNAL_URL o site subiria quebrado.
if (process.env.VERCEL && !process.env.API_INTERNAL_URL?.startsWith('https://')) {
  throw new Error('Defina API_INTERNAL_URL (https://...) nas variáveis de ambiente do projeto na Vercel.');
}
const apiUrl = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // O navegador fala só com esta origem; /api/* é encaminhado à API NestJS.
  // Assim o cookie de sessão é httpOnly, same-site e a API dispensa CORS.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.APP_ENV ?? 'development',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
