import { z } from 'zod';
import { APPOINTMENT_STATUSES, CANCELLATION_REASONS, type CancellationReason } from './appointment-status';
import { isValidCpf, normalizeBrPhone, onlyDigits, UF_LIST } from './br';
import { isValidTimeZone, parseTimeToMinutes } from './time';

/** Converte string vazia/só espaços em undefined, para campos opcionais de formulário. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const requiredText = (min: number, max: number, label: string) =>
  z.string({ error: `${label} é obrigatório.` }).trim().min(min, { error: `${label} deve ter ao menos ${min} caracteres.` }).max(max);

export const emailSchema = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'E-mail inválido.' }).max(254));

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use o formato HH:MM.' });
const isoDateSchema = z.iso.date({ error: 'Data inválida.' });
const isoInstantSchema = z.iso.datetime({ offset: true, error: 'Data e hora inválidas.' });

// ---------------------------------------------------------------- Identidade

export const signupSchema = z.object({
  name: requiredText(2, 120, 'Nome'),
  email: emailSchema,
  password: z
    .string({ error: 'Informe a senha.' })
    .min(10, { error: 'A senha deve ter ao menos 10 caracteres.' })
    .max(200, { error: 'Senha longa demais.' }),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ error: 'Informe a senha.' }).min(1, { error: 'Informe a senha.' }).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

const newPassword = z
  .string({ error: 'Informe a nova senha.' })
  .min(10, { error: 'A senha deve ter ao menos 10 caracteres.' })
  .max(200, { error: 'Senha longa demais.' });

export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(100), password: newPassword });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1, { error: 'Informe a senha atual.' }).max(200), newPassword });
export const mfaCodeSchema = z.object({ code: z.string().trim().min(6, { error: 'Informe o código.' }).max(20) });
export const mfaLoginSchema = z.object({ challengeToken: z.string().min(10).max(100), code: z.string().trim().min(6).max(20) });
export const mfaDisableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) });

// -------------------------------------------------------------- Organização

export const businessHoursSchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      opensAt: timeSchema,
      closesAt: timeSchema,
    }),
  )
  .max(21)
  .superRefine((items, ctx) => {
    items.forEach((h, i) => {
      if (parseTimeToMinutes(h.opensAt) >= parseTimeToMinutes(h.closesAt)) {
        ctx.addIssue({ code: 'custom', path: [i, 'closesAt'], message: 'O fechamento deve ser depois da abertura.' });
      }
    });
    for (let d = 0; d <= 6; d++) {
      const day = items
        .filter((h) => h.weekday === d)
        .map((h) => [parseTimeToMinutes(h.opensAt), parseTimeToMinutes(h.closesAt)] as const)
        .sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < day.length; i++) {
        if (day[i]![0] < day[i - 1]![1]) {
          ctx.addIssue({ code: 'custom', path: [], message: 'Há intervalos de funcionamento sobrepostos no mesmo dia.' });
          return;
        }
      }
    }
  });
export type BusinessHoursInput = z.infer<typeof businessHoursSchema>;

export const unitSchema = z.object({
  name: requiredText(2, 80, 'Nome da unidade'),
  timezone: z.string().refine(isValidTimeZone, { error: 'Fuso horário inválido.' }),
  phone: z.preprocess(blankToUndefined, z.string().optional()).refine((v) => v === undefined || normalizeBrPhone(v) !== null, {
    error: 'Telefone inválido. Use DDD + número.',
  }),
  addressLine: optionalText(200),
  city: optionalText(80),
  state: z.preprocess(blankToUndefined, z.enum(UF_LIST, { error: 'UF inválida.' }).optional()),
});
export type UnitInput = z.infer<typeof unitSchema>;

export const createOrganizationSchema = z.object({
  name: requiredText(2, 120, 'Nome da clínica'),
  unit: unitSchema,
  businessHours: businessHoursSchema,
  /** Plano escolhido na página de planos (preservado durante o cadastro). */
  planKey: z.preprocess(blankToUndefined, z.string().max(40).optional()),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const inviteSchema = z
  .object({
    email: emailSchema,
    roleId: z.uuid({ error: 'Selecione um papel.' }),
    allUnits: z.boolean(),
    unitIds: z.array(z.uuid()).max(50).default([]),
  })
  .refine((v) => v.allUnits || v.unitIds.length > 0, { error: 'Selecione ao menos uma unidade.', path: ['unitIds'] });
export type InviteInput = z.infer<typeof inviteSchema>;

export const professionalSchema = z.object({
  displayName: requiredText(2, 120, 'Nome de exibição'),
  membershipId: z.preprocess(blankToUndefined, z.uuid().optional()),
  croNumber: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{1,8}$/, { error: 'CRO deve conter apenas números.' }).optional()),
  croUf: z.preprocess(blankToUndefined, z.enum(UF_LIST, { error: 'UF do CRO inválida.' }).optional()),
  specialties: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Cor inválida.' }),
  unitIds: z.array(z.uuid()).min(1, { error: 'Selecione ao menos uma unidade.' }).max(50),
  active: z.boolean().default(true),
});
export type ProfessionalInput = z.infer<typeof professionalSchema>;

export const chairSchema = z.object({
  unitId: z.uuid({ error: 'Selecione a unidade.' }),
  name: requiredText(1, 60, 'Nome'),
  kind: z.enum(['chair', 'room']),
  active: z.boolean().default(true),
});
export type ChairInput = z.infer<typeof chairSchema>;

export const serviceSchema = z.object({
  name: requiredText(2, 120, 'Nome do serviço'),
  durationMinutes: z
    .number({ error: 'Informe a duração.' })
    .int()
    .min(5, { error: 'Duração mínima de 5 minutos.' })
    .max(480, { error: 'Duração máxima de 8 horas.' })
    .refine((v) => v % 5 === 0, { error: 'Use múltiplos de 5 minutos.' }),
  /** Valor em reais com duas casas decimais, como string para não perder precisão. */
  price: z.preprocess(blankToUndefined, z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, { error: 'Valor inválido.' }).optional()),
  active: z.boolean().default(true),
});
export type ServiceInput = z.infer<typeof serviceSchema>;

// ----------------------------------------------------------------- Pacientes

export const patientSchema = z.object({
  fullName: requiredText(3, 160, 'Nome completo'),
  socialName: optionalText(160),
  birthDate: z.preprocess(
    blankToUndefined,
    isoDateSchema.refine((d) => d <= new Date().toISOString().slice(0, 10) && d >= '1900-01-01', {
      error: 'Data de nascimento fora do intervalo permitido.',
    }).optional(),
  ),
  cpf: z.preprocess(
    blankToUndefined,
    z.string().refine(isValidCpf, { error: 'CPF inválido.' }).transform(onlyDigits).optional(),
  ),
  phone: z.preprocess(
    blankToUndefined,
    z
      .string()
      .refine((v) => normalizeBrPhone(v) !== null, { error: 'Telefone inválido. Use DDD + número.' })
      .transform((v) => normalizeBrPhone(v)!)
      .optional(),
  ),
  email: z.preprocess(blankToUndefined, emailSchema.optional()),
  /** Observações administrativas. Não é campo clínico. */
  administrativeNotes: optionalText(1000),
});
export type PatientInput = z.infer<typeof patientSchema>;

export const patientSearchSchema = z.object({
  q: optionalText(100),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// -------------------------------------------------------------------- Agenda

const durationSchema = z
  .number({ error: 'Informe a duração.' })
  .int()
  .min(5, { error: 'Duração mínima de 5 minutos.' })
  .max(480, { error: 'Duração máxima de 8 horas.' });

export const repeatSchema = z
  .object({
    frequency: z.enum(['weekly', 'biweekly', 'monthly']),
    count: z.number().int().min(2, { error: 'Repita ao menos 2 vezes.' }).max(52, { error: 'No máximo 52 ocorrências.' }),
  })
  .optional();

export const createAppointmentSchema = z.object({
  unitId: z.uuid({ error: 'Selecione a unidade.' }),
  patientId: z.uuid({ error: 'Selecione o paciente.' }),
  professionalId: z.uuid({ error: 'Selecione o profissional.' }),
  chairId: z.preprocess(blankToUndefined, z.uuid().optional()),
  serviceId: z.preprocess(blankToUndefined, z.uuid().optional()),
  startsAt: isoInstantSchema,
  durationMinutes: durationSchema,
  notes: optionalText(500),
  repeat: repeatSchema,
  /** Na recorrência: cria as ocorrências livres e informa as que conflitam. */
  skipConflicts: z.boolean().default(false),
  waitlistEntryId: z.preprocess(blankToUndefined, z.uuid().optional()),
  treatmentItemId: z.preprocess(blankToUndefined, z.uuid().optional()),
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const rescheduleAppointmentSchema = z.object({
  professionalId: z.uuid(),
  chairId: z.uuid().nullable(),
  startsAt: isoInstantSchema,
  durationMinutes: durationSchema,
  /** Versão lida pelo cliente; impede sobrescrever alteração concorrente. */
  version: z.number().int().min(1),
});
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;

const cancellationReasonKeys = Object.keys(CANCELLATION_REASONS) as [CancellationReason, ...CancellationReason[]];

export const transitionAppointmentSchema = z.object({
  to: z.enum(APPOINTMENT_STATUSES),
  reason: z.enum(cancellationReasonKeys).optional(),
  note: optionalText(300),
  version: z.number().int().min(1),
});
export type TransitionAppointmentInput = z.infer<typeof transitionAppointmentSchema>;

export const agendaQuerySchema = z.object({
  unitId: z.uuid(),
  date: isoDateSchema,
});

export const auditQuerySchema = z.object({
  entityType: optionalText(60),
  entityId: z.preprocess(blankToUndefined, z.uuid().optional()),
  action: optionalText(80),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const scheduleBlockSchema = z
  .object({
    unitId: z.uuid({ error: 'Selecione a unidade.' }),
    professionalId: z.preprocess(blankToUndefined, z.uuid().optional()),
    chairId: z.preprocess(blankToUndefined, z.uuid().optional()),
    kind: z.enum(['block', 'vacation', 'break', 'maintenance']),
    reason: optionalText(200),
    startsAt: isoInstantSchema,
    endsAt: isoInstantSchema,
    repeat: repeatSchema,
    /** Confirma a criação mesmo com consultas no período (gera tarefa de reagendamento). */
    acknowledgeConflicts: z.boolean().default(false),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { error: 'O fim deve ser depois do início.', path: ['endsAt'] })
  .refine((v) => new Date(v.endsAt).getTime() - new Date(v.startsAt).getTime() <= 62 * 86_400_000, { error: 'Período máximo de 62 dias por bloqueio.', path: ['endsAt'] });
export type ScheduleBlockInput = z.infer<typeof scheduleBlockSchema>;

export const agendaRangeQuerySchema = z
  .object({ unitId: z.uuid(), from: isoDateSchema, to: isoDateSchema })
  .refine((v) => v.to >= v.from, { error: 'Período inválido.' });

export const waitlistSchema = z.object({
  patientId: z.uuid({ error: 'Selecione o paciente.' }),
  unitId: z.preprocess(blankToUndefined, z.uuid().optional()),
  professionalId: z.preprocess(blankToUndefined, z.uuid().optional()),
  serviceId: z.preprocess(blankToUndefined, z.uuid().optional()),
  durationMinutes: durationSchema,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  period: z.enum(['any', 'morning', 'afternoon', 'evening']).default('any'),
  earliestDate: z.preprocess(blankToUndefined, isoDateSchema.optional()),
  latestDate: z.preprocess(blankToUndefined, isoDateSchema.optional()),
  priority: z.number().int().min(0).max(2).default(0),
  notes: optionalText(300),
});
export type WaitlistInput = z.infer<typeof waitlistSchema>;

export const COMMUNICATION_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export const COMMUNICATION_CATEGORIES = ['transactional', 'relationship', 'promotional'] as const;
export const COMMUNICATION_CATEGORY_LABEL = {
  transactional: 'Avisos do atendimento (confirmações, lembretes)',
  relationship: 'Relacionamento (retornos, pesquisas)',
  promotional: 'Campanhas e novidades',
} as const;

export const communicationPrefsSchema = z.object({
  preferences: z
    .array(z.object({ channel: z.enum(COMMUNICATION_CHANNELS), category: z.enum(COMMUNICATION_CATEGORIES), allowed: z.boolean() }))
    .max(9),
});

export const patientPreferencesSchema = z.object({
  preferredChannel: z.preprocess(blankToUndefined, z.enum(['email', 'sms', 'whatsapp', 'phone']).optional()),
  preferredPeriod: z.preprocess(blankToUndefined, z.enum(['morning', 'afternoon', 'evening']).optional()),
  accessibilityNeeds: optionalText(300),
  welcomeNotes: optionalText(300),
});

export const representativeSchema = z.object({
  fullName: requiredText(3, 160, 'Nome'),
  relationship: requiredText(2, 60, 'Parentesco'),
  cpf: z.preprocess(blankToUndefined, z.string().refine(isValidCpf, { error: 'CPF inválido.' }).transform(onlyDigits).optional()),
  phone: z.preprocess(blankToUndefined, z.string().refine((v) => normalizeBrPhone(v) !== null, { error: 'Telefone inválido.' }).transform((v) => normalizeBrPhone(v)!).optional()),
  email: z.preprocess(blankToUndefined, emailSchema.optional()),
  isLegalGuardian: z.boolean().default(true),
});

export const taskSchema = z.object({
  title: requiredText(3, 160, 'Título'),
  description: optionalText(1000),
  dueAt: z.preprocess(blankToUndefined, isoInstantSchema.optional()),
  assigneeMembershipId: z.preprocess(blankToUndefined, z.uuid().optional()),
  unitId: z.preprocess(blankToUndefined, z.uuid().optional()),
});
