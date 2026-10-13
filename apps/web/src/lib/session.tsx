'use client';

import type { Permission } from '@oralis/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';

export interface UnitSummary {
  id: string;
  name: string;
  timezone: string;
}

export interface Membership {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  isDemo: boolean;
  /** A clínica exige MFA para este papel e o usuário ainda não ativou. */
  mfaRequired: boolean;
  role: { id: string; key: string | null; name: string };
  permissions: Permission[];
  allUnits: boolean;
  units: UnitSummary[];
  professionalId: string | null;
  subscription: { status: string | null; planName: string | null; features: string[]; trialEndsAt: string | null; access: 'full' | 'read_only'; accessReason: string };
}

export interface Me {
  user: { id: string; name: string; email: string; mfaEnabled: boolean };
  memberships: Membership[];
}

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => api.get<Me>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 60_000,
  });
}

interface OrgContextValue {
  me: Me;
  membership: Membership;
  orgId: string;
  can: (p: Permission) => boolean;
  unit: UnitSummary | null;
  setUnitId: (id: string) => void;
  switchOrg: (orgId: string) => void;
}

const OrgContext = createContext<OrgContextValue | null>(null);

const ORG_KEY = 'oralis.activeOrg';
const UNIT_KEY = 'oralis.activeUnit';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // preferências locais são opcionais
  }
}

/**
 * Resolve a organização e a unidade ativas. As permissões aqui servem apenas
 * para a interface esconder ações; a API verifica tudo de novo.
 */
function allowContextChange(): boolean {
  return !document.querySelector('[data-unsaved="true"]') || window.confirm('Há alterações não salvas. Deseja sair desta edição?');
}

export function OrgProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [unitId, setUnitIdState] = useState<string | null>(null);

  useEffect(() => {
    const pref = readPref(ORG_KEY);
    const chosen = me.memberships.find((m) => m.organizationId === pref) ?? me.memberships[0];
    setOrgId(chosen?.organizationId ?? null);
  }, [me]);

  const membership = me.memberships.find((m) => m.organizationId === orgId) ?? null;

  useEffect(() => {
    if (!membership) return;
    const pref = readPref(`${UNIT_KEY}.${membership.organizationId}`);
    setUnitIdState((membership.units.find((u) => u.id === pref) ?? membership.units[0])?.id ?? null);
  }, [membership]);

  const setUnitId = useCallback(
    (id: string) => {
      if (!allowContextChange()) return;
      setUnitIdState(id);
      if (membership) writePref(`${UNIT_KEY}.${membership.organizationId}`, id);
    },
    [membership],
  );

  const switchOrg = useCallback(
    (id: string) => {
      if (!allowContextChange()) return;
      writePref(ORG_KEY, id);
      setOrgId(id);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] === 'org' });
    },
    [qc],
  );

  const value = useMemo<OrgContextValue | null>(() => {
    if (!membership) return null;
    const perms = new Set(membership.permissions);
    return {
      me,
      membership,
      orgId: membership.organizationId,
      can: (p) => perms.has(p),
      unit: membership.units.find((u) => u.id === unitId) ?? null,
      setUnitId,
      switchOrg,
    };
  }, [me, membership, unitId, setUnitId, switchOrg]);

  if (!value) return null;
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg fora de OrgProvider');
  return ctx;
}

export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    if (!allowContextChange()) return;
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      router.replace('/entrar');
    }
  };
}
