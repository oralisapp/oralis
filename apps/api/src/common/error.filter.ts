import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorBody } from '@oralis/shared';
import type { Response } from 'express';
import { pgConstraint, pgErrorCode } from '../db/db';
import { AppError } from './app-error';

/**
 * Converte qualquer erro em `{ error: { code, message, details } }`.
 * Erros inesperados são registrados sem corpo da requisição (que pode conter
 * dados pessoais) e devolvidos como mensagem genérica.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toBody(exception);
    body.error.requestId = res.locals.requestId as string | undefined;
    if (status >= 500) this.logger.error(JSON.stringify({ requestId: res.locals.requestId, name: exception instanceof Error ? exception.name : "Unknown", code: pgErrorCode(exception), status }));
    res.status(status).json(body);
  }

  private toBody(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppError) {
      return { status: exception.status, body: { error: { code: exception.code, message: exception.message, details: exception.details } } };
    }
    if (exception instanceof ThrottlerException) {
      return { status: 429, body: { error: { code: 'rate_limited', message: 'Muitas tentativas. Aguarde um minuto e tente novamente.' } } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) return { status, body: { error: { code: 'not_found', message: 'Recurso não encontrado.' } } };
      if (status === 503) return { status, body: { error: { code: 'internal_error', message: 'Serviço temporariamente indisponível. Tente novamente.' } } };
      if (status === 400 || status === 413) {
        return { status: 422, body: { error: { code: 'validation_failed', message: 'Requisição inválida.' } } };
      }
    }

    const code = pgErrorCode(exception);
    if (code === '23P01') {
      // Corrida rara entre a verificação prévia e a gravação: o banco garantiu a regra.
      return {
        status: 409,
        body: { error: { code: 'schedule_conflict', message: 'Este horário acabou de ser ocupado. Atualize a agenda e escolha outro.', details: { constraint: pgConstraint(exception) } } },
      };
    }
    if (code === '23505') {
      return { status: 409, body: { error: { code: 'conflict', message: 'Já existe um registro com estes dados.' } } };
    }
    if (code === '23514') {
      const constraint = pgConstraint(exception);
      const raw = exception instanceof Error ? (exception as Error & { cause?: Error }).cause?.message ?? exception.message : '';
      return { status: 422, body: { error: { code: 'validation_failed', message: constraint ? 'Os valores informados violam uma regra de consistência.' : raw || 'Operação inválida.' } } };
    }
    if (code === '23503') {
      return { status: 422, body: { error: { code: 'validation_failed', message: 'Referência inválida para esta organização.' } } };
    }

    return { status: 500, body: { error: { code: 'internal_error', message: 'Erro inesperado. Tente novamente; se persistir, contate o suporte.' } } };
  }
}
