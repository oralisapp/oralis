import { Injectable } from '@nestjs/common';

/**
 * Fonte única de "agora" para regras de negócio dependentes de tempo
 * (check-in no dia, falta após o início). Os testes substituem por um
 * relógio fixo para serem reproduzíveis em qualquer horário.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
