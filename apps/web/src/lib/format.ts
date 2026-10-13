import { formatBrPhone, formatCpf } from '@oralis/shared';

/** Formatação sempre em pt-BR e no fuso da unidade (não no do navegador). */

export function fmtTime(iso: string | Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

export function fmtDate(iso: string | Date, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'short' }): string {
  return new Intl.DateTimeFormat('pt-BR', { ...opts, timeZone: tz }).format(new Date(iso));
}

export function fmtDateTime(iso: string | Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

/** "terça-feira, 12 de março" para uma data AAAA-MM-DD (sem fuso: é data civil). */
export function fmtLongDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Data civil AAAA-MM-DD → DD/MM/AAAA, sem conversão de fuso. */
export function fmtCivilDate(day: string | null | undefined): string {
  if (!day) return '—';
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function ageFrom(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty! - by!;
  if (tm! < bm! || (tm === bm && td! < bd!)) age--;
  return age;
}

export function fmtPhone(digits: string | null | undefined): string {
  return digits ? formatBrPhone(digits) : '—';
}

export function fmtCpf(digits: string | null | undefined): string {
  return digits ? formatCpf(digits) : '—';
}

export function fmtMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value));
}

export function minutesBetween(fromIso: string | Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60_000));
}

export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

export function initials(name: string): string {
  const parts = name.replace(/^(dra?\.)\s+/i, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}
