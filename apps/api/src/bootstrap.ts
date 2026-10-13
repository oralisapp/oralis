import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { requestTrace } from './common/request-trace';
import { env } from './config/env';

/** Configuração HTTP compartilhada entre o servidor e os testes. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  // O front-end (Next.js) faz proxy de /api/*. Localmente o proxy é 127.0.0.1;
  // hospedado (Vercel → provedor da API), TRUST_PROXY diz quantos saltos confiar
  // para que req.ip seja o IP real do cliente (usado no limite de tentativas de login).
  app.use(requestTrace);
  const trust = env().TRUST_PROXY;
  express.set('trust proxy', trust === 'loopback' ? 'loopback' : Number(trust));
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '256kb' });
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  // Sem CORS: o navegador só fala com a API pela mesma origem do front-end.
}
