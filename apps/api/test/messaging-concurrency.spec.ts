import { eq } from 'drizzle-orm';
import { communicationEvents } from '../src/db/schema';
import { MessagingService } from '../src/modules/engagement/messaging.service';
import { MobileMessageProvider } from '../src/modules/engagement/mobile-message-provider';
import { createClinic, createPatient, createTestApp, resetDb, type TestContext } from './helpers';

describe('Messaging weekly reservation', () => {
  let t: TestContext;
  beforeAll(async () => { t = await createTestApp(); await resetDb(t.db); });
  afterAll(async () => { jest.restoreAllMocks(); await t.close(); });

  it('counts in-flight sends across channels and releases the DB transaction before provider IO', async () => {
    const clinic = await createClinic(t.app, 'message-concurrency@example.test');
    const patientId = await createPatient(clinic.owner, clinic.orgId, 'Concurrent Patient', { email: 'patient@example.test', phone: '92999991234' });
    await clinic.owner.put(`/orgs/${clinic.orgId}/patients/${patientId}/communication`, {
      preferences: ['email', 'sms', 'whatsapp'].map(channel => ({ channel, category: 'relationship', allowed: true })),
    });
    const service = t.app.get(MessagingService);
    const input = { organizationId: clinic.orgId, patientId, category: 'relationship' as const, body: 'Mensagem de relacionamento' };
    expect((await service.send({ ...input, channel: 'email' })).status).toBe('logged_locally');

    let release!: () => void;
    const providerGate = new Promise<void>(resolve => { release = resolve; });
    const provider = t.app.get(MobileMessageProvider);
    jest.spyOn(provider, 'configured').mockReturnValue(true);
    const send = jest.spyOn(provider, 'send').mockImplementation(async () => {
      await providerGate;
      return { status: 'queued', detail: 'Accepted by test provider' };
    });
    let blocked = 0;
    let blockedComplete!: () => void;
    const fourBlocked = new Promise<void>(resolve => { blockedComplete = resolve; });
    const pending = Array.from({ length: 6 }, (_, i) => service.send({ ...input, channel: i % 2 ? 'sms' : 'whatsapp' }).then(result => {
      if (result.status === 'blocked_frequency' && ++blocked === 4) blockedComplete();
      return result;
    }));
    let timer: NodeJS.Timeout | undefined;
    try {
      // The remaining requests must finish while both provider requests are held.
      // A transaction lock held during HTTP would deadlock this assertion.
      await Promise.race([fourBlocked, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Frequency reservations did not complete while provider IO was pending')), 10000);
      })]);
      expect(send).toHaveBeenCalledTimes(2);
      const reserved = await t.db.select().from(communicationEvents).where(eq(communicationEvents.patientId, patientId));
      expect(reserved.filter(event => event.status === 'queued')).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      release();
    }
    const result = await Promise.all(pending);
    expect(result.filter(event => event.status === 'blocked_frequency')).toHaveLength(4);
    expect(result.filter(event => event.status === 'queued')).toHaveLength(2);
    const events = await t.db.select().from(communicationEvents).where(eq(communicationEvents.patientId, patientId));
    expect(events).toHaveLength(7); // one row per request; provider results update reservations
  });
});
