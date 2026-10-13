'use client';

import type { AppointmentStatus, BusinessHoursInput, Permission } from '@oralis/shared';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from './api';
import { useOrg } from './session';

export interface AgendaAppointment {
  id: string;
  unitId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  version: number;
  notes: string | null;
  cancellationReason: string | null;
  patientId: string;
  patientName: string;
  patientSocialName: string | null;
  patientPhone: string | null;
  professionalId: string;
  chairId: string | null;
  serviceId: string | null;
  serviceName: string | null;
  arrivedAt: string | null;
  seriesId: string | null;
  treatmentItemId: string | null;
}

export interface ScheduleBlock {
  id: string;
  kind: 'block' | 'vacation' | 'break' | 'maintenance';
  reason: string | null;
  professionalId: string | null;
  chairId: string | null;
  startsAt: string;
  endsAt: string;
  seriesId: string | null;
}

export const BLOCK_KIND_LABEL: Record<ScheduleBlock['kind'], string> = { block: 'Bloqueio', vacation: 'Férias', break: 'Intervalo', maintenance: 'Manutenção' };

export interface AgendaProfessional {
  id: string;
  displayName: string;
  color: string;
  membershipId: string | null;
  specialties: string[];
}

export interface Agenda {
  unit: { id: string; name: string; timezone: string };
  date: string;
  businessHours: { weekday: number; opensAt: string; closesAt: string }[];
  professionals: AgendaProfessional[];
  chairs: { id: string; name: string; kind: string }[];
  services: { id: string; name: string; durationMinutes: number }[];
  appointments: AgendaAppointment[];
  blocks: ScheduleBlock[];
  serverNow: string;
}

export interface AgendaRange {
  unit: { id: string; name: string; timezone: string };
  from: string;
  to: string;
  businessHours: { weekday: number; opensAt: string; closesAt: string }[];
  professionals: AgendaProfessional[];
  appointments: AgendaAppointment[];
  blocks: ScheduleBlock[];
}

export interface WaitlistEntry {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  unitId: string | null;
  professionalId: string | null;
  professionalName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  durationMinutes: number;
  weekdays: number[];
  period: 'any' | 'morning' | 'afternoon' | 'evening';
  earliestDate: string | null;
  latestDate: string | null;
  priority: number;
  notes: string | null;
  status: string;
  createdAt: string;
}

export interface WaitlistSuggestion {
  entryId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  durationMinutes: number;
  serviceId: string | null;
  reasons: string[];
}

export interface Task {
  id: string;
  unitId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  status: 'open' | 'done' | 'cancelled';
  origin: string;
  relatedType: string | null;
  relatedId: string | null;
  assigneeName: string | null;
  assigneeRoleKey: string | null;
  createdAt: string;
}

export interface AppointmentDetail {
  appointment: AgendaAppointment;
  history: {
    id: string;
    fromStatus: AppointmentStatus | null;
    toStatus: AppointmentStatus;
    fromLabel: string | null;
    toLabel: string;
    reasonLabel: string | null;
    note: string | null;
    changedAt: string;
    changedByName: string;
  }[];
}

export interface PatientListItem {
  id: string;
  fullName: string;
  socialName: string | null;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  hasCpf: boolean;
}

export interface PatientDetail {
  patient: {
    id: string;
    fullName: string;
    socialName: string | null;
    birthDate: string | null;
    cpf: string | null;
    phone: string | null;
    email: string | null;
    administrativeNotes: string | null;
    status: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  appointments:
    | {
        id: string;
        startsAt: string;
        endsAt: string;
        status: AppointmentStatus;
        statusLabel: string;
        unitName: string;
        timezone: string;
        professionalName: string;
        serviceName: string | null;
      }[]
    | null;
}

export interface Unit {
  id: string;
  name: string;
  timezone: string;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  active: boolean;
  businessHours: BusinessHoursInput;
}

export interface Professional {
  id: string;
  displayName: string;
  membershipId: string | null;
  croNumber: string | null;
  croUf: string | null;
  specialties: string[];
  color: string;
  active: boolean;
  unitIds: string[];
}

export interface Chair {
  id: string;
  unitId: string;
  name: string;
  kind: 'chair' | 'room';
  active: boolean;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  price: string | null;
  active: boolean;
}

export interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: string;
  allUnits: boolean;
  roleId: string;
  roleKey: string | null;
  roleName: string;
  unitIds: string[];
}

export interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  permissions: Permission[];
}

export interface OnboardingStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  optional: boolean;
  href: string;
  allowed: boolean;
  dependsOn: string[];
}

/** Todas as chaves de consulta começam com 'org' + id, para limpar tudo ao trocar de organização. */
export function useOrgQuery<T>(key: unknown[], path: string, enabled = true, refetchOnWindowFocus = true) {
  const { orgId } = useOrg();
  return useQuery({ queryKey: ['org', orgId, ...key], queryFn: () => api.get<T>(`/orgs/${orgId}${path}`), enabled, refetchOnWindowFocus });
}

export const useAgenda = (unitId: string | undefined, date: string) =>
  useOrgQuery<Agenda>(['agenda', unitId, date], `/agenda${qs({ unitId, date })}`, !!unitId);

export const useAppointment = (id: string | null) => useOrgQuery<AppointmentDetail>(['appointment', id], `/appointments/${id}`, !!id);

export const usePatients = (q: string, page = 1) =>
  useOrgQuery<{ items: PatientListItem[]; total: number; page: number; pageSize: number }>(['patients', q, page], `/patients${qs({ q, page })}`);

// Cada leitura da ficha é auditada; evita recargas automáticas ao focar a janela.
export const usePatient = (id: string) => useOrgQuery<PatientDetail>(['patient', id], `/patients/${id}`, true, false);
export const useUnits = () => useOrgQuery<Unit[]>(['units'], '/units');
export const useProfessionals = () => useOrgQuery<Professional[]>(['professionals'], '/professionals');
export const useChairs = () => useOrgQuery<Chair[]>(['chairs'], '/chairs');
export const useServices = () => useOrgQuery<Service[]>(['services'], '/services');
export const useMembers = (enabled = true) => useOrgQuery<Member[]>(['members'], '/members', enabled);
export const useRoles = (enabled = true) => useOrgQuery<Role[]>(['roles'], '/roles', enabled);
export const useInvitations = (enabled = true) =>
  useOrgQuery<{ id: string; email: string; roleName: string; createdAt: string; expiresAt: string }[]>(['invitations'], '/invitations', enabled);
export const useOnboarding = () => useOrgQuery<{ steps: OnboardingStep[]; requiredDone: number; requiredTotal: number }>(['onboarding'], '/onboarding');

export const useAgendaRange = (unitId: string | undefined, from: string, to: string) =>
  useOrgQuery<AgendaRange>(['agenda-range', unitId, from, to], `/agenda/range${qs({ unitId, from, to })}`, !!unitId);
export const useOpenSlots = (unitId: string | undefined, date: string, enabled = true) =>
  useOrgQuery<{ slots: { professionalId: string; startsAt: string; endsAt: string; minutes: number }[]; professionals: AgendaProfessional[] }>(['open-slots', unitId, date], `/agenda/open-slots${qs({ unitId, date })}`, !!unitId && enabled);
export const useWaitlist = (status = 'active') => useOrgQuery<WaitlistEntry[]>(['waitlist', status], `/waitlist${qs({ status })}`);
export const useWaitlistSuggestions = (p: { unitId?: string; professionalId?: string; startsAt?: string; endsAt?: string } | null) =>
  useOrgQuery<WaitlistSuggestion[]>(['waitlist-suggestions', p], `/waitlist/suggestions${qs(p ?? {})}`, !!p?.unitId && !!p.professionalId);
export const useTasks = (scope: 'mine' | 'all' = 'mine', status: 'open' | 'done' = 'open') => useOrgQuery<Task[]>(['tasks', scope, status], `/tasks${qs({ scope, status })}`);

export interface TreatmentItem {
  id: string;
  planId: string;
  stage: number;
  priority: 'low' | 'normal' | 'high';
  description: string;
  serviceId: string | null;
  serviceName: string | null;
  tooth: number | null;
  surfaces: string[];
  professionalId: string | null;
  professionalName: string | null;
  dependsOnItemId: string | null;
  sessionsPlanned: number;
  unitPrice: string;
  status: 'planned' | 'scheduled' | 'done' | 'cancelled';
  doneAt: string | null;
  appointments: { id: string; startsAt: string; status: string }[];
}

export interface QuoteVersion {
  id: string;
  version: number;
  items: { itemId: string; description: string; serviceName: string | null; tooth: number | null; surfaces: string[]; stage: number; sessions: number; price: string }[];
  subtotal: string;
  discount: string;
  discountReason: string | null;
  total: string;
  paymentTerms: { installments: number; method: string; firstDueDate: string };
  validUntil: string;
  presentedAt: string;
  presentedByName: string;
}

export interface PlanDetail {
  plan: {
    id: string;
    patientId: string;
    patientName: string;
    unitId: string;
    unitName: string;
    timezone: string;
    title: string;
    objective: string | null;
    status: 'draft' | 'presented' | 'approved' | 'rejected' | 'in_progress' | 'completed' | 'cancelled';
    sharedWithPatient: boolean;
    responsibleProfessionalId: string | null;
    responsibleName: string | null;
    createdAt: string;
  };
  items: TreatmentItem[];
  totals: { itemsTotal: string };
  quotes: {
    id: string;
    status: 'presented' | 'approved' | 'rejected' | 'expired';
    currentVersionId: string | null;
    lastContactAt: string | null;
    versions: QuoteVersion[];
    decisions: { id: string; versionId: string; decision: 'approved' | 'rejected'; reason: string | null; via: 'clinic' | 'portal'; decidedByName: string | null; acknowledgedName: string | null; createdAt: string }[];
  }[];
}

export interface ContinuityPlan {
  id: string;
  patientId: string;
  patientName: string;
  title: string;
  status: PlanDetail['plan']['status'];
  responsibleName: string | null;
  stage: 'evaluation' | 'presented' | 'approved' | 'scheduled' | 'in_progress' | 'completed' | 'follow_up';
  progress: { done: number; total: number };
  nextSessionAt: string | null;
  pending: { code: string; label: string }[];
  updatedAt: string;
}

export const usePlan = (id: string) => useOrgQuery<PlanDetail>(['plan', id], `/treatment-plans/${id}`);
export const usePatientPlans = (patientId: string, enabled = true) => useOrgQuery<{ id: string; title: string; status: PlanDetail['plan']['status']; createdAt: string; responsibleName: string | null }[]>(['patient-plans', patientId], `/patients/${patientId}/treatment-plans`, enabled);
export const useContinuity = () => useOrgQuery<{ plans: ContinuityPlan[]; counts: Record<string, number> }>(['continuity'], '/treatment-plans/continuity');

export interface Receivable {
  id: string;
  unitId: string;
  patientId: string | null;
  patientName: string | null;
  professionalId: string | null;
  planId: string | null;
  description: string;
  amount: string;
  paid: string;
  balance: string;
  dueDate: string;
  installmentNo: number;
  installmentsTotal: number;
  status: 'open' | 'paid' | 'cancelled';
  view: 'open' | 'partial' | 'overdue' | 'partial_overdue' | 'paid' | 'cancelled';
  collectionHold: boolean;
  collectionHoldReason: string | null;
}
export interface Payment {
  id: string;
  cashAccountId: string;
  patientId: string | null;
  patientName: string | null;
  amount: string;
  method: string;
  receivedAt: string;
  notes: string | null;
  reconciledAt: string | null;
  createdByName: string;
  refunded: string;
  refundPending: string;
}
export interface CashAccount { id: string; unitId: string; unitName: string; name: string; kind: string; balance: string }
export interface FinanceCategory { id: string; name: string; kind: 'income' | 'expense'; active: boolean }
export const useFinance = <T,>(key: string, path: string, enabled = true) => useOrgQuery<T>(['finance', key, path], `/finance${path}`, enabled);
