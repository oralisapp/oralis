'use client';
import { CalendarDays, UserRound, ArrowUpRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useOrgQuery } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { fmtDateTime } from '@/lib/format';
import { ErrorState } from './ui/feedback';
interface SearchData {
 patients: { id: string; title: string; href: string }[];
 appointments: { id: string; patientName: string; patientSocialName: string | null; startsAt: string; timezone: string; unitName: string; professionalName: string; href: string }[];
}
export function GlobalSearchResults({ search, open, onNavigate }: { search: string; open: boolean; onNavigate: () => void }) {
 const { can } = useOrg();
 const [term,setTerm]=useState('');
 useEffect(()=>{const timer=setTimeout(()=>setTerm(search.trim()),300);return()=>clearTimeout(timer);},[search]);
 const enabled=open && term.length>=2 && (can('patients.read') || can('schedule.read'));
 const q=useOrgQuery<SearchData>(['global-search',term],`/search?q=${encodeURIComponent(term)}`,enabled,false);
 if(!open || search.trim().length<2 || !enabled) return null;
 return <div className="mb-4 border-b border-border pb-4" aria-live="polite">
  {(q.isLoading || term!==search.trim()) && <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />Buscando na clínica...</p>}
  {q.error && <ErrorState error={q.error} onRetry={()=>q.refetch()} />}
  {q.data && term===search.trim() && <>
   {q.data.patients.length>0 && <><p className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted">Pacientes</p>{q.data.patients.map(p=><Link key={p.id} href={p.href} onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm hover:bg-primary-soft"><UserRound className="size-4 shrink-0 text-primary" aria-hidden /><span className="min-w-0 flex-1 truncate">{p.title}</span><ArrowUpRight className="size-4 text-muted" aria-hidden /></Link>)}</>}
   {q.data.appointments.length>0 && <><p className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted">Consultas · mais recentes</p>{q.data.appointments.map(a=><Link key={a.id} href={a.href} onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-primary-soft"><CalendarDays className="size-4 shrink-0 text-primary" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{a.patientSocialName || a.patientName}</span><span className="block truncate text-[11px] text-muted">{fmtDateTime(a.startsAt,a.timezone)} · {a.professionalName} · {a.unitName}</span></span><ArrowUpRight className="size-4 text-muted" aria-hidden /></Link>)}</>}
   {!q.data.patients.length && !q.data.appointments.length && <p className="px-3 py-3 text-xs text-muted">Nenhum paciente ou consulta encontrado. Tente nome, telefone ou CPF.</p>}
  </>}
 </div>;
}
