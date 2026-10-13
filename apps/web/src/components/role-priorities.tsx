'use client';
import { todayInTz } from '@oralis/shared';
import { ArrowUpRight, FilePenLine, ShieldCheck, Wallet, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useOrgQuery, useAgenda } from '@/lib/queries';
import { useOrg } from '@/lib/session';
import { fmtMoney, fmtDateTime } from '@/lib/format';
import { Card, CardHeader, ErrorState, LoadingBlock } from './ui/feedback';

function DraftPriorities() {
 const { unit }=useOrg();
 const q=useOrgQuery<{id:string;patientId:string;patientName:string;updatedAt:string;appointmentId:string|null}[]>(['pending-drafts'],'/clinical/pending-drafts');
 return <Card><CardHeader icon={<FilePenLine className="size-4" aria-hidden />} title="Evoluções para finalizar" description="Seus rascunhos, inclusive de atendimentos concluídos." />{q.isLoading && <LoadingBlock rows={2}/>} {q.error && <ErrorState error={q.error} onRetry={()=>q.refetch()}/>}{q.data && <div className="p-5">{!q.data.length ? <p className="text-sm text-muted">Seus registros estão em dia.</p> : <><p className="mb-3 text-xs text-warning">{q.data.length===50?'50 ou mais':q.data.length} evolução(ões) aguardando revisão.</p><ul className="space-y-3">{q.data.slice(0,5).map(d=><li key={d.id}><Link href={d.appointmentId?`/app/atendimentos/${d.appointmentId}`:`/app/pacientes/${d.patientId}?aba=clinico`} className="flex items-center justify-between gap-3 rounded-lg p-2 hover:bg-surface-2"><span className="min-w-0"><span className="block truncate text-sm font-semibold">{d.patientName}</span><span className="block text-[11px] text-muted">Última edição {fmtDateTime(d.updatedAt,unit?.timezone ?? 'America/Sao_Paulo')}</span></span><ArrowUpRight className="size-4 shrink-0" aria-hidden /></Link></li>)}</ul></>}</div>}</Card>;
}
function FinancePriorities() {
 const {unit}=useOrg();const to=todayInTz(unit?.timezone ?? 'America/Sao_Paulo');const from=to.slice(0,7)+'-01';
 const query=new URLSearchParams({from,to,...(unit?{unitId:unit.id}:{})});
 const q=useOrgQuery<Record<string,{value:string;definition:string}>>(['role-finance',unit?.id,from,to],`/finance/reports/summary?${query}`);
 return <Card><CardHeader icon={<Wallet className="size-4" aria-hidden />} title="Prioridades financeiras" description="Saldo da unidade e movimento no mês até hoje." />{q.isLoading && <LoadingBlock rows={2}/>} {q.error && <ErrorState error={q.error} onRetry={()=>q.refetch()}/>} {q.data && <div className="divide-y divide-border px-5">{[{key:'openBalance',label:'Saldo a receber',href:'/app/financeiro?aba=receber&status=open'},{key:'overdueBalance',label:'Saldo vencido',href:'/app/financeiro?aba=receber&status=overdue'},{key:'received',label:'Recebido líquido no mês',href:'/app/financeiro?aba=recebimentos'}].map(m=><Link key={m.key} href={m.href} className="flex items-center justify-between gap-3 py-4 hover:text-primary-text"><span className="text-xs text-muted">{m.label}</span><span className="flex items-center gap-2 text-sm font-bold">{fmtMoney(q.data?.[m.key]?.value ?? '0')}<ArrowUpRight className="size-3.5" aria-hidden /></span></Link>)}</div>}</Card>;
}
function OperationPriorities() {
 const q=useOrgQuery<{failedJobs:number;staleJobs:number;failedEmails:number}>(['operation-health'],'/workspace/operations');
 return <Card><CardHeader icon={<ShieldCheck className="size-4" aria-hidden />} title="Atenção da gestão" description="Falhas de processamento registradas nesta clínica." />{q.isLoading && <LoadingBlock rows={2}/>} {q.error && <ErrorState error={q.error} onRetry={()=>q.refetch()}/>} {q.data && <div className="p-5"><div className="grid grid-cols-3 gap-3">{[['Tarefas falharam',q.data.failedJobs],['Execuções presas',q.data.staleJobs],['E-mails falharam',q.data.failedEmails]].map(([label,n])=><div key={label}><p className={`text-2xl font-semibold ${Number(n)?'text-warning':'text-primary-text'}`}>{n}</p><p className="mt-1 text-[10px] text-muted">{label}</p></div>)}</div><p className="mt-4 text-xs text-muted">{q.data.failedJobs+q.data.staleJobs+q.data.failedEmails?'Revise o histórico de comunicação e encaminhe falhas de processamento ao suporte.':'Nenhuma falha nesses indicadores.'}</p><Link href="/app/auditoria" className="mt-3 inline-block text-xs font-semibold text-primary-text">Consultar auditoria →</Link></div>}</Card>;
}
function ReceptionPriorities() {
 const {unit,can}=useOrg();const today=todayInTz(unit?.timezone ?? 'America/Sao_Paulo');const q=useAgenda(unit?.id,today);
 return <Card><CardHeader icon={<PhoneCall className="size-4" aria-hidden />} title="Prioridades da recepção" description="Confirmações e chegada dos pacientes de hoje."/>{q.isLoading && <LoadingBlock rows={2}/>} {q.error && <ErrorState error={q.error} onRetry={()=>q.refetch()}/>} {q.data && <div className="p-5"><p className="text-sm"><strong className="text-2xl text-primary-text">{q.data.appointments.filter(a=>a.status==='scheduled').length}</strong> aguardando confirmação</p><p className="mt-3 text-sm"><strong className="text-2xl text-warning">{q.data.appointments.filter(a=>a.status==='arrived').length}</strong> na recepção</p><div className="mt-4 flex flex-wrap gap-4 text-xs font-semibold text-primary-text"><Link href="/app/agenda">Organizar chegadas →</Link>{can('crm.read') && <Link href="/app/relacionamento">Acompanhar contatos →</Link>}</div></div>}</Card>;
}
export function RolePriorities() {
 const {can,membership}=useOrg();
 const manager=['owner','manager'].includes(membership.role.key ?? '');
 return <section className="mb-6" aria-label="Prioridades do seu perfil"><p className="mb-3 text-[10px] font-bold uppercase tracking-[.16em] text-muted">Prioridades · {membership.role.name}</p><div className="grid gap-4 lg:grid-cols-2">{can('clinical.write') && (!manager || !!membership.professionalId) && <DraftPriorities/>}{can('finance.read') && <FinancePriorities/>}{can('audit.read') && <OperationPriorities/>}{can('schedule.read') && !manager && !can('clinical.write') && <ReceptionPriorities/>}</div></section>;
}
