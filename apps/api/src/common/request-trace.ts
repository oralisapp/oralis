import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
const logger = new Logger('HTTP');
/** Correlação sem registrar URLs completas, tokens, corpo ou dados de pacientes. */
export function requestTrace(req: Request, res: Response, next: NextFunction) {
 const id = randomUUID();
 const start = performance.now();
 res.locals.requestId = id;
 res.setHeader('x-request-id', id);
 res.on('finish', () => {
  const elapsedMs = Math.round(performance.now() - start);
  if (res.statusCode >= 500 || elapsedMs >= 1500) logger.warn(JSON.stringify({ requestId: id, method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode, elapsedMs }));
 });
 next();
}
