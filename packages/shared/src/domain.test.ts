import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  SYSTEM_ROLES,
  businessHoursSchema,
  dayRangeInTz,
  findTransition,
  fitsBusinessHours,
  isValidCpf,
  normalizeBrPhone,
  patientSchema,
  zonedParts,
  zonedToInstant,
} from './index';

describe('máquina de estados da consulta', () => {
  it('estados terminais não possuem saída', () => {
    expect(APPOINTMENT_TRANSITIONS.completed).toHaveLength(0);
    expect(APPOINTMENT_TRANSITIONS.cancelled).toHaveLength(0);
    expect(APPOINTMENT_TRANSITIONS.no_show).toHaveLength(0);
  });

  it('não permite pular do agendado para concluído', () => {
    expect(findTransition('scheduled', 'completed')).toBeUndefined();
    expect(findTransition('scheduled', 'in_progress')).toBeUndefined();
  });

  it('segue o fluxo previsto → confirmado → chegou → em atendimento → concluído', () => {
    expect(findTransition('scheduled', 'confirmed')).toBeDefined();
    expect(findTransition('confirmed', 'arrived')).toBeDefined();
    expect(findTransition('arrived', 'in_progress')).toBeDefined();
    expect(findTransition('in_progress', 'completed')).toBeDefined();
  });

  it('todo destino de transição é um status conhecido e cancelamento exige motivo', () => {
    for (const from of APPOINTMENT_STATUSES) {
      for (const t of APPOINTMENT_TRANSITIONS[from]) {
        expect(APPOINTMENT_STATUSES).toContain(t.to);
        if (t.to === 'cancelled') expect(t.requiresReason).toBe(true);
      }
    }
  });
});

describe('papéis do sistema', () => {
  it('recepção e financeiro não têm acesso clínico', () => {
    for (const key of ['reception', 'finance', 'assistant', 'manager'] as const) {
      expect(SYSTEM_ROLES[key].permissions).not.toContain('clinical.read');
      expect(SYSTEM_ROLES[key].permissions).not.toContain('clinical.write');
    }
  });

  it('financeiro não agenda consultas', () => {
    expect(SYSTEM_ROLES.finance.permissions).not.toContain('schedule.write');
  });
});

describe('fuso horário', () => {
  it('interpreta horário local de São Paulo (UTC-3)', () => {
    expect(zonedToInstant('2026-10-06', '09:00', 'America/Sao_Paulo').toISOString()).toBe('2026-10-06T12:00:00.000Z');
  });

  it('interpreta horário local de Manaus (UTC-4)', () => {
    expect(zonedToInstant('2026-10-06', '09:00', 'America/Manaus').toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });

  it('dia civil cobre 24h no fuso da unidade', () => {
    const { start, end } = dayRangeInTz('2026-10-06', 'America/Sao_Paulo');
    expect(start.toISOString()).toBe('2026-10-06T03:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-07T03:00:00.000Z');
  });

  it('extrai dia da semana e minutos no fuso', () => {
    const parts = zonedParts(new Date('2026-10-06T02:30:00Z'), 'America/Sao_Paulo');
    expect(parts).toEqual({ date: '2026-10-05', weekday: 1, minutes: 23 * 60 + 30 });
  });
});

describe('horário de funcionamento', () => {
  const tz = 'America/Sao_Paulo';
  // terça-feira, 06/10/2026
  const hours = [
    { weekday: 2, opensAt: '08:00', closesAt: '12:00' },
    { weekday: 2, opensAt: '13:00', closesAt: '18:00' },
  ];

  it('aceita consulta dentro de um intervalo', () => {
    expect(fitsBusinessHours(zonedToInstant('2026-10-06', '08:00', tz), zonedToInstant('2026-10-06', '09:00', tz), tz, hours)).toBe(true);
    expect(fitsBusinessHours(zonedToInstant('2026-10-06', '17:00', tz), zonedToInstant('2026-10-06', '18:00', tz), tz, hours)).toBe(true);
  });

  it('rejeita consulta que atravessa o intervalo de almoço', () => {
    expect(fitsBusinessHours(zonedToInstant('2026-10-06', '11:30', tz), zonedToInstant('2026-10-06', '12:30', tz), tz, hours)).toBe(false);
  });

  it('rejeita dia sem expediente', () => {
    expect(fitsBusinessHours(zonedToInstant('2026-10-04', '09:00', tz), zonedToInstant('2026-10-04', '10:00', tz), tz, hours)).toBe(false);
  });

  it('valida intervalos sobrepostos', () => {
    const r = businessHoursSchema.safeParse([
      { weekday: 1, opensAt: '08:00', closesAt: '12:00' },
      { weekday: 1, opensAt: '11:00', closesAt: '14:00' },
    ]);
    expect(r.success).toBe(false);
  });
});

describe('formatos brasileiros', () => {
  it('valida dígitos do CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
  });

  it('normaliza telefone e rejeita DDD inexistente', () => {
    expect(normalizeBrPhone('+55 (11) 98765-4321')).toBe('11987654321');
    expect(normalizeBrPhone('(00) 98765-4321')).toBeNull();
    expect(normalizeBrPhone('(11) 88765-4321')).toBeNull();
  });

  it('paciente: campos opcionais vazios viram undefined e CPF é normalizado', () => {
    const r = patientSchema.parse({ fullName: 'Paciente Teste', cpf: '529.982.247-25', phone: '', email: '' });
    expect(r.cpf).toBe('52998224725');
    expect(r.phone).toBeUndefined();
    expect(r.email).toBeUndefined();
  });
});

import { fromCents, percentOf, splitInstallments, toCents } from './money';
import { isValidTooth } from './odontogram';

describe('dinheiro em centavos', () => {
  it('converte sem erro de ponto flutuante', () => {
    expect(toCents('0.1') + toCents('0.2')).toBe(30);
    expect(toCents('1234.5')).toBe(123450);
    expect(fromCents(123450)).toBe('1234.50');
    expect(fromCents(-5)).toBe('-0.05');
  });
  it('parcelas somam o total e a diferença vai para a primeira', () => {
    expect(splitInstallments(10000, 3)).toEqual([3334, 3333, 3333]);
    expect(splitInstallments(10000, 3).reduce((a, b) => a + b, 0)).toBe(10000);
  });
  it('percentual arredonda half-up', () => {
    expect(percentOf(999, 10)).toBe(100);
    expect(percentOf(1000, 12.5)).toBe(125);
  });
  it('rejeita valor inválido', () => {
    expect(() => toCents('12,50')).toThrow();
  });
});

describe('odontograma FDI', () => {
  it('valida a numeração permanente e decídua', () => {
    expect([11, 18, 48, 51, 85].every(isValidTooth)).toBe(true);
    expect([10, 19, 49, 56, 90].some(isValidTooth)).toBe(false);
  });
});
