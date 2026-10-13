import { eq } from 'drizzle-orm';
import request from 'supertest';
import { CSRF_HEADER } from '@oralis/shared';
import { appointments, tasks } from '../src/db/schema';
import { type Clinic, type TestContext, addMember, at, createChair, createClinic, createPatient, createProfessional, createTestApp, resetDb } from './helpers';

describe('Agenda avançada', () => {
  let t: TestContext;
  let c: Clinic;
  let prof: string;
  let prof2: string;
  let chair: string;
  let p1: string;
  let p2: string;
  let p3: string;
  const url = (p: string) => `/orgs/${c.orgId}${p}`;
  const book = (o: Record<string, unknown>) => c.owner.post(url('/appointments'), { unitId: c.unitId, durationMinutes: 30, ...o });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    c = await createClinic(t.app, 'agenda-avancada@exemplo.test');
    prof = await createProfessional(c, 'Dra. Bloqueio');
    prof2 = await createProfessional(c, 'Dr. Livre');
    chair = await createChair(c, 'Cadeira A');
    p1 = await createPatient(c.owner, c.orgId, 'Paciente Um', { email: 'um@paciente.example' });
    p2 = await createPatient(c.owner, c.orgId, 'Paciente Dois');
    p3 = await createPatient(c.owner, c.orgId, 'Paciente Três');
  });
  afterAll(() => t.close());
  beforeEach(() => t.clock.set('2030-03-12T13:00:00.000Z'));

  describe('bloqueios', () => {
    it('bloqueio do profissional impede agendar só para ele', async () => {
      const b = await c.owner.post(url('/schedule-blocks'), { unitId: c.unitId, professionalId: prof, kind: 'block', reason: 'Curso', startsAt: at('2030-03-20', '09:00'), endsAt: at('2030-03-20', '12:00') });
      expect(b.status).toBe(201);
      const denied = await book({ patientId: p1, professionalId: prof, startsAt: at('2030-03-20', '10:00') });
      expect(denied.status).toBe(409);
      expect(denied.body.error.message).toMatch(/bloqueado.*Curso/);
      expect((await book({ patientId: p1, professionalId: prof2, startsAt: at('2030-03-20', '10:00') })).status).toBe(201);
    });

    it('bloqueio da unidade inteira impede todos os profissionais', async () => {
      await c.owner.post(url('/schedule-blocks'), { unitId: c.unitId, kind: 'maintenance', startsAt: at('2030-03-21', '13:00'), endsAt: at('2030-03-21', '15:00') });
      expect((await book({ patientId: p2, professionalId: prof2, startsAt: at('2030-03-21', '14:00') })).status).toBe(409);
    });

    it('férias sobre consultas marcadas exigem confirmação e geram tarefa de reagendamento', async () => {
      const appt = await book({ patientId: p3, professionalId: prof2, startsAt: at('2030-04-02', '09:00') });
      expect(appt.status).toBe(201);
      const body = { unitId: c.unitId, professionalId: prof2, kind: 'vacation', startsAt: at('2030-04-01', '00:00'), endsAt: at('2030-04-06', '00:00') };
      const first = await c.owner.post(url('/schedule-blocks'), body);
      expect(first.status).toBe(409);
      expect(first.body.error.details.affected).toHaveLength(1);
      const ok = await c.owner.post(url('/schedule-blocks'), { ...body, acknowledgeConflicts: true });
      expect(ok.status).toBe(201);
      expect(ok.body.affectedAppointments).toBe(1);
      const open = await t.db.select().from(tasks).where(eq(tasks.relatedId, ok.body.ids[0]));
      expect(open).toHaveLength(1);
      // A consulta existente não é cancelada automaticamente.
      const [row] = await t.db.select().from(appointments).where(eq(appointments.id, appt.body.id));
      expect(row!.status).toBe('scheduled');
    });

    it('bloqueio recorrente semanal cria as ocorrências e pode ser removido em série', async () => {
      const r = await c.owner.post(url('/schedule-blocks'), { unitId: c.unitId, professionalId: prof, kind: 'break', startsAt: at('2030-05-06', '12:00'), endsAt: at('2030-05-06', '13:00'), repeat: { frequency: 'weekly', count: 4 } });
      expect(r.body.ids).toHaveLength(4);
      const del = await c.owner.delete(url(`/schedule-blocks/${r.body.ids[0]}?series=true`));
      expect(del.body.removed).toBe(4);
    });
  });

  describe('recorrência de consultas', () => {
    it('cria uma série semanal mantendo o horário local', async () => {
      const r = await book({ patientId: p2, professionalId: prof, startsAt: at('2030-06-03', '08:00'), repeat: { frequency: 'weekly', count: 4 } });
      expect(r.status).toBe(201);
      expect(r.body.created.map((x: { startsAt: string }) => x.startsAt)).toEqual(['2030-06-03T11:00:00.000Z', '2030-06-10T11:00:00.000Z', '2030-06-17T11:00:00.000Z', '2030-06-24T11:00:00.000Z']);
      expect(r.body.seriesId).toBeTruthy();
    });

    it('com conflito em uma ocorrência: recusa tudo, ou cria as livres se pedido', async () => {
      await book({ patientId: p3, professionalId: prof2, startsAt: at('2030-07-08', '10:00') });
      const body = { patientId: p1, professionalId: prof2, startsAt: at('2030-07-01', '10:00'), repeat: { frequency: 'weekly', count: 3 } };
      const refused = await book(body);
      expect(refused.status).toBe(409);
      expect(refused.body.error.details.occurrences).toHaveLength(1);
      const partial = await book({ ...body, skipConflicts: true });
      expect(partial.status).toBe(201);
      expect(partial.body.created).toHaveLength(2);
      expect(partial.body.skipped).toHaveLength(1);
    });
  });

  it('visão por período devolve consultas e bloqueios da semana', async () => {
    const r = await c.owner.get(url(`/agenda/range?unitId=${c.unitId}&from=2030-03-18&to=2030-03-24`));
    expect(r.status).toBe(200);
    expect(r.body.blocks.length).toBeGreaterThanOrEqual(2);
    expect(r.body.appointments.length).toBeGreaterThanOrEqual(1);
  });

  it('vagas abertas descontam consultas e bloqueios', async () => {
    const r = await c.owner.get(url(`/agenda/open-slots?unitId=${c.unitId}&date=2030-03-20&minMinutes=30`));
    const mine = r.body.slots.filter((s: { professionalId: string }) => s.professionalId === prof);
    // Bloqueio das 09:00 às 12:00: a primeira vaga da Dra. Bloqueio é 08:00–09:00, a segunda começa 12:00.
    expect(mine[0]).toMatchObject({ startsAt: '2030-03-20T11:00:00.000Z', minutes: 60 });
    expect(mine[1].startsAt).toBe('2030-03-20T15:00:00.000Z');
  });

  it('mantém disponível o restante de uma vaga que começou antes de agora', async () => {
    t.clock.set('2030-03-19T16:07:00.000Z'); // 13:07 na clínica
    const r = await c.owner.get(url(`/agenda/open-slots?unitId=${c.unitId}&date=2030-03-19&minMinutes=30`));
    expect(r.status).toBe(200);
    const mine = r.body.slots.filter((s: { professionalId: string }) => s.professionalId === prof2);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].startsAt).toBe('2030-03-19T16:15:00.000Z');
    expect(mine.every((s: { startsAt: string; minutes: number }) => new Date(s.startsAt) > t.clock.now() && s.minutes >= 30)).toBe(true);
  });

  describe('lista de espera', () => {
    let entryId: string;

    it('sugere apenas candidatos compatíveis, explicando os critérios', async () => {
      const ok = await c.owner.post(url('/waitlist'), { patientId: p2, durationMinutes: 30, weekdays: [3], period: 'afternoon' });
      entryId = ok.body.id;
      await c.owner.post(url('/waitlist'), { patientId: p3, durationMinutes: 90, weekdays: [] }); // longo demais
      await c.owner.post(url('/waitlist'), { patientId: p1, durationMinutes: 30, weekdays: [1] }); // outro dia
      const q = `?unitId=${c.unitId}&professionalId=${prof2}&startsAt=${encodeURIComponent(at('2030-03-27', '15:00'))}&endsAt=${encodeURIComponent(at('2030-03-27', '16:00'))}`;
      const r = await c.owner.get(url(`/waitlist/suggestions${q}`));
      expect(r.body.map((s: { patientId: string }) => s.patientId)).toEqual([p2]);
      expect(r.body[0].reasons.join(' ')).toMatch(/Quarta/);
    });

    it('agendar a partir da lista marca o item e impede usar o mesmo item duas vezes', async () => {
      const first = await book({ patientId: p2, professionalId: prof2, startsAt: at('2030-03-27', '15:00'), waitlistEntryId: entryId });
      expect(first.status).toBe(201);
      const again = await book({ patientId: p2, professionalId: prof2, startsAt: at('2030-03-28', '15:00'), waitlistEntryId: entryId });
      expect(again.status).toBe(409);
      const list = await c.owner.get(url('/waitlist?status=scheduled'));
      expect(list.body.map((e: { id: string }) => e.id)).toContain(entryId);
    });
  });

  describe('link seguro de confirmação', () => {
    let apptId: string;
    let token: string;
    const server = () => t.app.getHttpServer();

    beforeAll(async () => {
      const r = await c.owner.post(url('/appointments'), { unitId: c.unitId, patientId: p1, professionalId: prof2, startsAt: at('2030-03-25', '11:00'), durationMinutes: 30 });
      apptId = r.body.id;
    });

    it('gera link e envia e-mail apenas com autorização (transacional permitido por padrão)', async () => {
      const r = await c.owner.post(url(`/appointments/${apptId}/confirmation-link`), { sendEmail: true });
      expect(r.status).toBe(201);
      expect(r.body.emailDelivery).toBe('logged_locally');
      token = r.body.url.split('/c/')[1];
    });

    it('página pública mostra o mínimo, sem procedimento nem sobrenome', async () => {
      const r = await request(server()).get(`/api/public/appointment-links/${token}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ state: 'pending', patientFirstName: 'Paciente' });
      expect(JSON.stringify(r.body)).not.toMatch(/Um|serviceName|cpf/);
    });

    it('confirmação pelo paciente fica no histórico com a origem correta', async () => {
      const r = await request(server()).post(`/api/public/appointment-links/${token}/confirm`).set(CSRF_HEADER, '1');
      expect(r.status).toBe(200);
      const d = await c.owner.get(url(`/appointments/${apptId}`));
      expect(d.body.appointment.status).toBe('confirmed');
      const last = d.body.history.at(-1);
      expect(last).toMatchObject({ toStatus: 'confirmed', source: 'patient_link', changedByName: 'Paciente (link de confirmação)' });
      // Repetir não muda nada.
      const again = await request(server()).post(`/api/public/appointment-links/${token}/confirm`).set(CSRF_HEADER, '1');
      expect(again.body.state).toBe('confirmed');
    });

    it('pedido de reagendamento vira tarefa e nunca move a consulta sozinho', async () => {
      const link = await c.owner.post(url(`/appointments/${apptId}/confirmation-link`), {});
      const tk = link.body.url.split('/c/')[1];
      const r = await request(server()).post(`/api/public/appointment-links/${tk}/reschedule-request`).set(CSRF_HEADER, '1').send({ message: 'Prefiro à tarde' });
      expect(r.body.state).toBe('reschedule_requested');
      const reception = await addMember(t.app, c, 'recepcao-link@exemplo.test', 'reception');
      const list = await reception.client.get(url('/tasks'));
      expect(list.body.some((x: { title: string; relatedId: string }) => x.relatedId === apptId && /reagendamento/.test(x.title))).toBe(true);
      const [row] = await t.db.select().from(appointments).where(eq(appointments.id, apptId));
      expect(row!.startsAt.toISOString()).toBe('2030-03-25T14:00:00.000Z');
    });

    it('e-mail não é enviado quando o paciente recusou avisos por e-mail', async () => {
      await c.owner.put(url(`/patients/${p1}/communication`), { preferences: [{ channel: 'email', category: 'transactional', allowed: false }] });
      const r = await c.owner.post(url(`/appointments/${apptId}/confirmation-link`), { sendEmail: true });
      expect(r.body.emailDelivery).toBe('not_allowed');
      const matrix = await c.owner.get(url(`/patients/${p1}/communication`));
      const promo = matrix.body.find((m: { channel: string; category: string }) => m.channel === 'email' && m.category === 'promotional');
      expect(promo.allowed).toBe(false); // promocional exige autorização explícita
    });

    it('token inválido não revela nada', async () => {
      const r = await request(server()).get('/api/public/appointment-links/token-que-nao-existe-123');
      expect(r.status).toBe(404);
    });
  });
});
