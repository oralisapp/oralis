import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

/**
 * Estratégia de datas: instantes são gravados em UTC (timestamptz) e toda
 * interpretação de "dia", "horário de funcionamento" e exibição acontece no
 * fuso IANA da unidade (ex.: America/Sao_Paulo, America/Manaus).
 */

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseDate(day: string): [number, number, number] {
  const m = DATE_RE.exec(day);
  if (!m) throw new Error(`Data inválida: ${day}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

export function parseTimeToMinutes(hhmm: string): number {
  const m = TIME_RE.exec(hhmm);
  if (!m) throw new Error(`Horário inválido: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Converte data + hora locais da unidade em um instante UTC. */
export function zonedToInstant(day: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = parseDate(day);
  const minutes = parseTimeToMinutes(hhmm);
  const z = new TZDate(y, mo, d, Math.floor(minutes / 60), minutes % 60, 0, tz);
  return new Date(z.getTime());
}

/** Intervalo [início, fim) do dia civil `day` no fuso `tz`. */
export function dayRangeInTz(day: string, tz: string): { start: Date; end: Date } {
  const [y, mo, d] = parseDate(day);
  const start = new TZDate(y, mo, d, 0, 0, 0, tz);
  const end = new TZDate(y, mo, d + 1, 0, 0, 0, tz);
  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}

export interface ZonedParts {
  /** AAAA-MM-DD no fuso informado */
  date: string;
  /** 0 = domingo … 6 = sábado */
  weekday: number;
  /** minutos desde 00:00 no fuso informado */
  minutes: number;
}

export function zonedParts(instant: Date, tz: string): ZonedParts {
  const z = new TZDate(instant.getTime(), tz);
  return {
    date: format(z, 'yyyy-MM-dd'),
    weekday: z.getDay(),
    minutes: z.getHours() * 60 + z.getMinutes(),
  };
}

export function todayInTz(tz: string, now: Date = new Date()): string {
  return zonedParts(now, tz).date;
}

export interface BusinessHoursInterval {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

/**
 * Verifica se [start, end) cabe inteiro em um dos intervalos de funcionamento
 * da unidade no dia local correspondente. Consultas não atravessam a meia-noite.
 */
export function fitsBusinessHours(
  start: Date,
  end: Date,
  tz: string,
  hours: readonly BusinessHoursInterval[],
): boolean {
  const s = zonedParts(start, tz);
  const e = zonedParts(end, tz);
  const endMinutes = e.date === s.date ? e.minutes : e.minutes === 0 ? 24 * 60 : -1;
  if (endMinutes < 0) return false;
  return hours.some(
    (h) =>
      h.weekday === s.weekday &&
      parseTimeToMinutes(h.opensAt) <= s.minutes &&
      endMinutes <= parseTimeToMinutes(h.closesAt),
  );
}

export const WEEKDAY_LABEL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
