import { Injectable } from '@nestjs/common';
import type { Tx } from '../../db/db';

export interface DomainEventMap {
  'appointment.created': { organizationId: string; appointmentId: string; actorUserId: string | null };
  'appointment.status_changed': { organizationId: string; appointmentId: string; from: string; to: string; actorUserId: string | null };
  'appointment.rescheduled': { organizationId: string; appointmentId: string; actorUserId: string | null };
  'stock.moved': { organizationId: string; itemId: string; unitId: string };
  'treatment_item.done': { organizationId: string; itemId: string; patientId: string; actorUserId: string | null };
  'quote.approved': { organizationId: string; quoteId: string; actorUserId: string | null };
}

type Handler<K extends keyof DomainEventMap> = (tx: Tx, payload: DomainEventMap[K]) => Promise<void>;

/**
 * Eventos de domínio síncronos, executados DENTRO da transação de quem emite:
 * se um tratador falhar, a operação inteira é desfeita (sem estado parcial).
 * Efeitos externos (e-mail, mensagens) devem apenas enfileirar tarefas.
 */
@Injectable()
export class DomainEvents {
  private readonly handlers = new Map<string, Handler<never>[]>();

  on<K extends keyof DomainEventMap>(event: K, handler: Handler<K>) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<never>);
    this.handlers.set(event, list);
  }

  async emit<K extends keyof DomainEventMap>(tx: Tx, event: K, payload: DomainEventMap[K]) {
    for (const h of this.handlers.get(event) ?? []) await (h as Handler<K>)(tx, payload);
  }
}
