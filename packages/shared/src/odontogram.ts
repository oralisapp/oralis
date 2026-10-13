/**
 * Odontograma em notação FDI (ISO 3950). A numeração exibida deve ser
 * validada pelo profissional responsável; o sistema não sugere diagnóstico.
 */

export const PERMANENT_TEETH = {
  upperRight: [18, 17, 16, 15, 14, 13, 12, 11],
  upperLeft: [21, 22, 23, 24, 25, 26, 27, 28],
  lowerLeft: [31, 32, 33, 34, 35, 36, 37, 38],
  lowerRight: [48, 47, 46, 45, 44, 43, 42, 41],
} as const;

export const DECIDUOUS_TEETH = {
  upperRight: [55, 54, 53, 52, 51],
  upperLeft: [61, 62, 63, 64, 65],
  lowerLeft: [71, 72, 73, 74, 75],
  lowerRight: [85, 84, 83, 82, 81],
} as const;

export function isValidTooth(n: number): boolean {
  const q = Math.floor(n / 10);
  const u = n % 10;
  return ([1, 2, 3, 4].includes(q) && u >= 1 && u <= 8) || ([5, 6, 7, 8].includes(q) && u >= 1 && u <= 5);
}

export const SURFACES = ['M', 'D', 'O', 'V', 'L'] as const;
export type Surface = (typeof SURFACES)[number];
export const SURFACE_LABEL: Record<Surface, string> = { M: 'Mesial', D: 'Distal', O: 'Oclusal/Incisal', V: 'Vestibular', L: 'Lingual/Palatina' };

/**
 * Condições registráveis. `symbol` e `pattern` garantem leitura sem
 * depender apenas de cor (legenda acessível).
 */
export const ODONTOGRAM_CONDITIONS = {
  caries: { label: 'Cárie', symbol: 'C', wholeTooth: false, pattern: 'dots' },
  restoration: { label: 'Restauração', symbol: 'R', wholeTooth: false, pattern: 'solid' },
  sealant: { label: 'Selante', symbol: 'S', wholeTooth: false, pattern: 'lines' },
  fracture: { label: 'Fratura', symbol: 'F', wholeTooth: false, pattern: 'cross' },
  crown: { label: 'Coroa', symbol: 'Co', wholeTooth: true, pattern: 'ring' },
  root_canal: { label: 'Tratamento de canal', symbol: 'TC', wholeTooth: true, pattern: 'root' },
  implant: { label: 'Implante', symbol: 'I', wholeTooth: true, pattern: 'square' },
  missing: { label: 'Ausente', symbol: 'A', wholeTooth: true, pattern: 'x' },
  extraction: { label: 'Extração indicada', symbol: 'E', wholeTooth: true, pattern: 'slash' },
  prosthesis: { label: 'Prótese', symbol: 'P', wholeTooth: true, pattern: 'ring' },
  other: { label: 'Outro (ver observação)', symbol: '?', wholeTooth: false, pattern: 'solid' },
} as const;

export type OdontogramCondition = keyof typeof ODONTOGRAM_CONDITIONS;

export const ODONTOGRAM_STATUS_LABEL = { existing: 'Situação atual', planned: 'Planejado', done: 'Realizado' } as const;

export const TREATMENT_PLAN_STATUS_LABEL = {
  draft: 'Em elaboração',
  presented: 'Apresentado',
  approved: 'Aprovado',
  rejected: 'Recusado',
  in_progress: 'Em andamento',
  completed: 'Concluído',
  cancelled: 'Cancelado',
} as const;

export const TREATMENT_ITEM_STATUS_LABEL = { planned: 'Planejado', scheduled: 'Agendado', done: 'Realizado', cancelled: 'Cancelado' } as const;
