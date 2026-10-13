import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { appointmentStatusHistory, appointments, auditEvents } from '../src/db/schema';
import {
  type Clinic,
  type TestContext,
  TODAY,
  at,
  createChair,
  createClinic,
  createPatient,
  createProfessional,
  createTestApp,
  resetDb,
} from './helpers';

describe('Agenda: conflitos, horário de funcionamento e transições', () => {
  let t: TestContext;
  let c: Clinic;
  let prof1: string;
  let prof2: string;
  let chair1: string;
  let p1: string;
  let p2: string;
  let p3: string;
  const url = () => `/orgs/${c.orgId}/appointments`;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'agenda@exemplo.test');
    prof1 = await createProfessional(c, 'Dra. Helena');
    prof2 = await createProfessional(c, 'Dr. Rafael');
    chair1 = await createChair(c, 'Cadeira 1');
    p1 = await createPatient(c.owner, c.orgId, 'Paciente Um');
    p2 = await createPatient(c.owner, c.orgId, 'Paciente Dois');
    p3 = await createPatient(c.owner, c.orgId, 'Paciente Três');
  });
  afterAll(() => t.close());
  beforeEach(() => t.clock.set('2030-03-12T13:00:00.000Z'));

  const book = (o: { patientId: string; professionalId: string; chairId?: string; start: string; minutes?: number; date?: string }) =>
    c.owner.post(url(), {
      unitId: c.unitId,
      patientId: o.patientId,
      professionalId: o.professionalId,
      chairId: o.chairId,
      startsAt: at(o.date ?? '2030-03-13', o.start),
      durationMinutes: o.minutes ?? 60,
    });

  describe('conflitos', () => {
    it('impede o mesmo profissional em horários sobrepostos', async () => {
      expect((await book({ patientId: p1, professionalId: prof1, start: '09:00' })).status).toBe(201);
      const r = await book({ patientId: p2, professionalId: prof1, start: '09:30', minutes: 30 });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('schedule_conflict');
      expect(r.body.error.details.conflicts[0].kind).toBe('professional');
    });

    it('permite horários encostados (fim 10:00, início 10:00)', async () => {
      expect((await book({ patientId: p2, professionalId: prof1, start: '10:00', minutes: 30 })).status).toBe(201);
    });

    it('impede a mesma cadeira com profissionais diferentes', async () => {
      expect((await book({ patientId: p1, professionalId: prof1, chairId: chair1, start: '14:00' })).status).toBe(201);
      const r = await book({ patientId: p2, professionalId: prof2, chairId: chair1, start: '14:30' });
      expect(r.status).toBe(409);
      expect(r.body.error.details.conflicts.map((x: { kind: string }) => x.kind)).toContain('chair');
    });

    it('impede o mesmo paciente em dois lugares ao mesmo tempo', async () => {
      const r = await book({ patientId: p1, professionalId: prof2, start: '14:15', minutes: 30 });
      expect(r.status).toBe(409);
      expect(r.body.error.details.conflicts.map((x: { kind: string }) => x.kind)).toContain('patient');
    });

    it('consulta cancelada libera o horário', async () => {
      const first = await book({ patientId: p3, professionalId: prof2, start: '16:00' });
      expect(first.status).toBe(201);
      const cancel = await c.owner.post(`${url()}/${first.body.id}/transitions`, { to: 'cancelled', reason: 'patient_request', version: 1 });
      expect(cancel.status).toBe(201);
      expect((await book({ patientId: p2, professionalId: prof2, start: '16:00' })).status).toBe(201);
    });

    it('requisições simultâneas para o mesmo horário: exatamente uma vence', async () => {
      const patients = await Promise.all(Array.from({ length: 8 }, (_, i) => createPatient(c.owner, c.orgId, `Concorrente ${i + 1}`)));
      const results = await Promise.all(patients.map((patientId) => book({ patientId, professionalId: prof2, start: '11:00', minutes: 30, date: '2030-03-14' })));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      const rows = await t.db.select().from(appointments).where(and(eq(appointments.professionalId, prof2), eq(appointments.startsAt, new Date('2030-03-14T14:00:00Z'))));
      expect(rows).toHaveLength(1);
    });

    it('a exclusion constraint do banco barra sobreposição mesmo sem a verificação da aplicação', async () => {
      const [existing] = await t.db.select().from(appointments).where(eq(appointments.professionalId, prof1)).limit(1);
      await expect(
        t.db.insert(appointments).values({ ...existing!, id: undefined, patientId: p3, chairId: null, version: 1 }),
      ).rejects.toMatchObject({ cause: { code: '23P01' } });
    });
  });

  describe('horário de funcionamento e validações', () => {
    it('recusa consulta fora do expediente e no fim de semana', async () => {
      const early = await book({ patientId: p3, professionalId: prof1, start: '07:30' });
      expect(early.status).toBe(422);
      expect(early.body.error.code).toBe('outside_business_hours');
      const crossesClose = await book({ patientId: p3, professionalId: prof1, start: '17:30' });
      expect(crossesClose.body.error.code).toBe('outside_business_hours');
      const saturday = await book({ patientId: p3, professionalId: prof1, start: '09:00', date: '2030-03-16' });
      expect(saturday.body.error.code).toBe('outside_business_hours');
    });

    it('recusa agendar no passado', async () => {
      const r = await book({ patientId: p3, professionalId: prof1, start: '08:00', date: '2030-03-11' });
      expect(r.status).toBe(422);
    });

    it('recusa profissional que não atende na unidade', async () => {
      const parque = await c.owner.post(`/orgs/${c.orgId}/units`, {
        unit: { name: 'Parque', timezone: 'America/Sao_Paulo' },
        businessHours: [{ weekday: 3, opensAt: '08:00', closesAt: '18:00' }],
      });
      const r = await c.owner.post(url(), { unitId: parque.body.id, patientId: p3, professionalId: prof1, startsAt: at('2030-03-13', '09:00'), durationMinutes: 30 });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/não atende nesta unidade/);
    });
  });

  describe('transições de status', () => {
    let id: string;

    beforeAll(async () => {
      const r = await book({ patientId: p3, professionalId: prof1, start: '15:00', minutes: 30, date: TODAY });
      expect(r.status).toBe(201);
      id = r.body.id;
    });

    const move = (to: string, version: number, extra: object = {}) => c.owner.post(`${url()}/${id}/transitions`, { to, version, ...extra });

    it('recusa salto inválido (agendado → concluído)', async () => {
      const r = await move('completed', 1);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('invalid_transition');
    });

    it('recusa versão desatualizada (alteração concorrente)', async () => {
      const r = await move('confirmed', 99);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('stale_version');
    });

    it('não registra falta antes do horário de início', async () => {
      const r = await move('no_show', 1);
      expect(r.body.error.message).toMatch(/depois do horário/);
    });

    it('percorre agendado → confirmado → chegou → em atendimento → concluído', async () => {
      expect((await move('confirmed', 1)).status).toBe(201);
      expect((await move('arrived', 2)).status).toBe(201);
      expect((await move('in_progress', 3)).status).toBe(201);
      expect((await move('completed', 4)).status).toBe(201);
      expect((await move('cancelled', 5, { reason: 'other' })).status).toBe(422);
    });

    it('histórico registra cada mudança com autor e horário', async () => {
      const r = await c.owner.get(`${url()}/${id}`);
      expect(r.status).toBe(200);
      expect(r.body.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['scheduled', 'confirmed', 'arrived', 'in_progress', 'completed']);
      expect(r.body.history.every((h: { changedByName: string; changedAt: string }) => h.changedByName === 'Proprietária' && h.changedAt)).toBe(true);
    });

    it('auditoria registra a criação e cada transição', async () => {
      const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
      expect(events.map((e) => e.action).sort()).toEqual([
        'appointment.created',
        ...Array(4).fill('appointment.status_changed'),
      ]);
    });

    it('check-in só no dia da consulta', async () => {
      const r = await book({ patientId: p3, professionalId: prof2, start: '09:00', minutes: 30, date: '2030-03-15' });
      const tr = await c.owner.post(`${url()}/${r.body.id}/transitions`, { to: 'arrived', version: 1 });
      expect(tr.status).toBe(422);
      expect(tr.body.error.message).toMatch(/dia da consulta/);
    });

    it('cancelamento exige motivo', async () => {
      const r = await book({ patientId: p2, professionalId: prof2, start: '10:00', minutes: 30, date: '2030-03-15' });
      const tr = await c.owner.post(`${url()}/${r.body.id}/transitions`, { to: 'cancelled', version: 1 });
      expect(tr.status).toBe(422);
    });
  });

  describe('reagendamento', () => {
    it('move a consulta, invalida a confirmação e audita antes/depois', async () => {
      const r = await book({ patientId: p1, professionalId: prof1, start: '09:00', minutes: 30, date: '2030-03-18' });
      await c.owner.post(`${url()}/${r.body.id}/transitions`, { to: 'confirmed', version: 1 });
      const mv = await c.owner.put(`${url()}/${r.body.id}/schedule`, {
        professionalId: prof1,
        chairId: null,
        startsAt: at('2030-03-18', '11:00'),
        durationMinutes: 30,
        version: 2,
      });
      expect(mv.status).toBe(200);
      expect(mv.body).toMatchObject({ status: 'scheduled', version: 3 });
      const [audit] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, r.body.id), eq(auditEvents.action, 'appointment.rescheduled')));
      expect(audit!.metadata).toMatchObject({ before: { startsAt: '2030-03-18T12:00:00.000Z' }, after: { startsAt: '2030-03-18T14:00:00.000Z' }, confirmationReset: true });
    });

    it('reagendar para horário ocupado é recusado', async () => {
      const a1 = await book({ patientId: p2, professionalId: prof2, start: '09:00', minutes: 30, date: '2030-03-19' });
      const a2 = await book({ patientId: p3, professionalId: prof2, start: '10:00', minutes: 30, date: '2030-03-19' });
      const mv = await c.owner.put(`${url()}/${a2.body.id}/schedule`, { professionalId: prof2, chairId: null, startsAt: at('2030-03-19', '09:15'), durationMinutes: 30, version: 1 });
      expect(mv.status).toBe(409);
      expect(a1.status).toBe(201);
    });
  });

  describe('integridade do histórico', () => {
    it('auditoria e histórico de status não podem ser alterados nem apagados', async () => {
      await expect(t.db.execute(sql`update audit_events set action = 'adulterado'`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(t.db.execute(sql`delete from appointment_status_history`)).rejects.toMatchObject({ cause: { code: '42501' } });
      const rows = await t.db.select().from(appointmentStatusHistory);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('agenda do dia', () => {
    it('devolve consultas do dia no fuso da unidade, com recursos para montar a grade', async () => {
      const r = await c.owner.get(`/orgs/${c.orgId}/agenda?unitId=${c.unitId}&date=2030-03-13`);
      expect(r.status).toBe(200);
      expect(r.body.unit.timezone).toBe('America/Sao_Paulo');
      expect(r.body.businessHours).toEqual([{ weekday: 3, opensAt: '08:00', closesAt: '18:00' }]);
      expect(r.body.professionals.map((p: { displayName: string }) => p.displayName).sort()).toEqual(['Dr. Rafael', 'Dra. Helena']);
      expect(r.body.appointments.every((a: { startsAt: string }) => a.startsAt.startsWith('2030-03-13'))).toBe(true);
    });
  });
});
