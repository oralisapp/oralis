'use client';

import { createContext, useContext } from 'react';

export interface PortalMe {
  patient: { firstName: string; fullName: string; email: string | null; phone: string | null };
  clinic: { name: string; units: { name: string; phone: string | null; addressLine: string | null; city: string | null; timezone: string }[] };
}

export const PortalContext = createContext<PortalMe | null>(null);
export const usePortal = () => useContext(PortalContext)!;
