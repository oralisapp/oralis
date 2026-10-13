/** Utilitários de formatos brasileiros. */

export function onlyDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

/** Valida dígitos verificadores do CPF. Não consulta nenhuma base externa. */
export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function formatCpf(value: string): string {
  const d = onlyDigits(value);
  if (d.length !== 11) return value;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** Exibe apenas os 3 dígitos centrais, como em comprovantes públicos. */
export function maskCpf(value: string): string {
  const d = onlyDigits(value);
  if (d.length !== 11) return '***';
  return `***.${d.slice(3, 6)}.***-**`;
}

/**
 * Telefone brasileiro: DDD (2 dígitos) + 8 ou 9 dígitos. Aceita prefixo 55.
 * Retorna apenas dígitos, sem o código do país, ou null se inválido.
 */
export function normalizeBrPhone(value: string): string | null {
  let d = onlyDigits(value);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (!/^[1-9][1-9]/.test(d)) return null; // DDD válido não contém zero
  if (d.length === 11 && d[2] !== '9') return null;
  return d;
}

export function formatBrPhone(digits: string): string {
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return digits;
}

export const UF_LIST = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;
