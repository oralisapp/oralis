/**
 * Dinheiro: toda conta é feita em CENTAVOS inteiros. No banco, numeric(12,2);
 * na API, string "1234.56". Nunca usar float para valores.
 *
 * Regra de arredondamento de parcelas: divide-se em centavos; a diferença
 * de arredondamento vai para a PRIMEIRA parcela (ex.: 100,00 em 3 = 33,34 + 33,33 + 33,33).
 * Percentuais (desconto, comissão) arredondam meio centavo para cima (half-up).
 */

export function toCents(value: string | number): number {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Valor monetário inválido: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function splitInstallments(totalCents: number, count: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error('Total inválido');
  if (!Number.isInteger(count) || count < 1) throw new Error('Quantidade de parcelas inválida');
  const base = Math.floor(totalCents / count);
  const parts = Array.from({ length: count }, () => base);
  parts[0]! += totalCents - base * count;
  return parts;
}

/** Percentual com 2 casas (ex.: 12.5 = 12,5%) aplicado em centavos, arredondamento half-up. */
export function percentOf(cents: number, percent: number): number {
  return Math.round((cents * Math.round(percent * 100)) / 10_000);
}

export function formatBRL(value: string | number): string {
  const cents = typeof value === 'number' ? value : toCents(value);
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}
