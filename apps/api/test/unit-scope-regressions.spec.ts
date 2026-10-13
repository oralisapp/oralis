import { JobsService } from '../src/modules/platform/jobs.service';
import { addMember, createClinic, createPatient, createTestApp, resetDb, type Clinic, type Client, type TestContext } from './helpers';

describe('Escopo de unidade em exportações e planos do paciente', () => {
 let t: TestContext;
 let c: Clinic;
 let manager: Client;
 let patient: string;
 let otherUnit: string;
 const url=(p:string)=>`/orgs/${c.orgId}${p}`;
 beforeAll(async()=>{
  t=await createTestApp();await resetDb(t.db);c=await createClinic(t.app,'scope-owner@example.test');
  manager=(await addMember(t.app,c,'scope-manager@example.test','manager',{allUnits:false,unitIds:[c.unitId]})).client;
  otherUnit=(await c.owner.post(url('/units'),{unit:{name:'Outra unidade',timezone:'America/Sao_Paulo'},businessHours:[]})).body.id;
  patient=await createPatient(c.owner,c.orgId,'Paciente escopo');
 });
 afterAll(async()=>{await t.close();});
 it('gestor de uma unidade não gera, lista ou baixa exportações organizacionais',async()=>{
  const own=await c.owner.post(url('/exports'),{scope:'patients'});
  expect(own.status).toBe(201);await t.app.get(JobsService).drain();
  expect((await c.owner.get(url('/exports'))).status).toBe(200);
  expect((await c.owner.get(url(`/exports/${own.body.id}/download`))).status).toBe(200);
  for(const scope of ['patients','appointments','financial','treatments'])expect((await manager.post(url('/exports'),{scope})).status).toBe(403);
  expect((await manager.get(url('/exports'))).status).toBe(403);
  expect((await manager.get(url(`/exports/${own.body.id}/download`))).status).toBe(403);
 });
 it('lista somente planos das unidades acessíveis e mantém acesso amplo do proprietário',async()=>{
  expect((await c.owner.post(url(`/patients/${patient}/treatment-plans`),{unitId:c.unitId,title:'Permitido'})).status).toBe(201);
  const hidden=await c.owner.post(url(`/patients/${patient}/treatment-plans`),{unitId:otherUnit,title:'Restrito'});
  expect(hidden.status).toBe(201);
  const list=await manager.get(url(`/patients/${patient}/treatment-plans`));
  expect(list.status).toBe(200);expect(list.body.map((p:{title:string})=>p.title)).toEqual(['Permitido']);
  expect((await manager.get(url(`/treatment-plans/${hidden.body.id}`))).status).toBe(404);
  expect((await c.owner.get(url(`/patients/${patient}/treatment-plans`))).body).toHaveLength(2);
 });
});
