'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface PortalAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'confirmed' | 'arrived' | 'in_progress' | 'completed' | 'no_show' | 'cancelled';
  unitName: string;
  timezone: string;
  address: string | null;
  professionalName: string;
  serviceName: string | null;
}
export interface PortalPlan {
  id: string;
  title: string;
  objective: string | null;
  status: string;
  responsibleName: string | null;
  items: { description: string; tooth: number | null; stage: number; status: string; unitPrice: string; sessionsPlanned: number }[];
  quote: { id: string; status: string; versionId: string; version: number; subtotal: string; discount: string; total: string; paymentTerms: { installments: number; method: string; firstDueDate: string }; validUntil: string; decision: { decision: string; createdAt: string } | null } | null;
}

export const usePortalQuery = <T,>(key: string, path: string) => useQuery({ queryKey: ['portal', key], queryFn: () => api.get<T>(`/portal${path}`) });
export const usePortalAppointments = () => usePortalQuery<{ upcoming: PortalAppointment[]; past: PortalAppointment[] }>('appointments', '/appointments');
export const usePortalPlans = () => usePortalQuery<PortalPlan[]>('plans', '/plans');
export const usePortalPayments = () =>
  usePortalQuery<{ receivables: { id: string; description: string; amount: string; balance: string; dueDate: string; view: string; status: string }[]; payments: { id: string; amount: string; method: string; receivedAt: string }[]; balance: string }>('payments', '/payments');
export const usePortalRequests = () => usePortalQuery<{ id: string; title: string; status: string; createdAt: string; completedAt: string | null }[]>('requests', '/requests');
