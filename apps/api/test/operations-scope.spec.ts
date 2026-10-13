import { addMember, createClinic, createPatient, createProfessional, createTestApp, resetDb, type Clinic, type Client, type TestContext } from './helpers';

describe('Operations references and unit isolation', () => {
  let t: TestContext;
  let clinic: Clinic;
  let foreign: Clinic;
  let manager: Client;
  let item: string;
  let foreignItem: string;
  let hiddenUnit: string;
  let patient: string;
  let lab: string;
  const url = (p: string) => `/orgs/${clinic.orgId}${p}`;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDb(t.db);
    clinic = await createClinic(t.app, 'operations-scope-owner@example.test');
    foreign = await createClinic(t.app, 'operations-foreign-owner@example.test');
    manager = (await addMember(t.app, clinic, 'operations-scoped-manager@example.test', 'manager', { allUnits: false, unitIds: [clinic.unitId] })).client;
    hiddenUnit = (await clinic.owner.post(url('/units'), { unit: { name: 'Restricted', timezone: 'America/Sao_Paulo' }, businessHours: [] })).body.id;
    item = (await clinic.owner.post(url('/inventory/items'), { name: 'Own material', unitMeasure: 'un' })).body.id;
    foreignItem = (await foreign.owner.post(`/orgs/${foreign.orgId}/inventory/items`, { name: 'Foreign material', unitMeasure: 'un' })).body.id;
    patient = await createPatient(clinic.owner, clinic.orgId, 'Operations Patient');
    lab = (await clinic.owner.post(url('/labs'), { name: 'Own laboratory' })).body.id;
  });
  afterAll(async () => { await t.close(); });

  it('rejects foreign units, suppliers and lots before stock writes', async () => {
    const supplier = (await foreign.owner.post(`/orgs/${foreign.orgId}/inventory/suppliers`, { name: 'Foreign supplier' })).body.id;
    const move = { itemId: item, unitId: clinic.unitId, type: 'in', quantity: '5' };
    expect((await clinic.owner.post(url('/inventory/movements'), { ...move, unitId: foreign.unitId })).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/movements'), { ...move, supplierId: supplier })).status).toBe(404);
    await foreign.owner.post(`/orgs/${foreign.orgId}/inventory/movements`, { ...move, itemId: foreignItem, unitId: foreign.unitId, lotCode: 'FOREIGN' });
    const lot = (await foreign.owner.get(`/orgs/${foreign.orgId}/inventory/items/${foreignItem}/movements`)).body[0].m.lotId;
    expect((await clinic.owner.post(url('/inventory/movements'), { ...move, lotId: lot })).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/transfers'), { itemId: item, fromUnitId: clinic.unitId, toUnitId: foreign.unitId, quantity: '1' })).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/transfers'), { itemId: item, fromUnitId: clinic.unitId, toUnitId: hiddenUnit, quantity: '1', lotId: lot })).status).toBe(404);
  });

  it('movement history includes only assigned units', async () => {
    for (const unitId of [clinic.unitId, hiddenUnit]) expect((await clinic.owner.post(url('/inventory/movements'), { itemId: item, unitId, type: 'in', quantity: '2' })).status).toBe(201);
    const history = await manager.get(url(`/inventory/items/${item}/movements`));
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].m.unitId).toBe(clinic.unitId);
  });

  it('material links require both references in the organization', async () => {
    const ownService = (await clinic.owner.post(url('/services'), { name: 'Own procedure', durationMinutes: 30 })).body.id;
    const foreignService = (await foreign.owner.post(`/orgs/${foreign.orgId}/services`, { name: 'Foreign procedure', durationMinutes: 30 })).body.id;
    expect((await clinic.owner.post(url('/inventory/materials'), { serviceId: foreignService, itemId: item, quantity: '1' })).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/materials'), { serviceId: ownService, itemId: foreignItem, quantity: '1' })).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/materials'), { serviceId: ownService, itemId: item, quantity: '1' })).status).toBe(201);
  });

  it('unselected lots are allocated FIFO for withdrawals and transfers without negative phantom lots', async () => {
    const stocked = (await clinic.owner.post(url('/inventory/items'), { name: 'Lot allocation', unitMeasure: 'un' })).body.id;
    const base = { itemId: stocked, unitId: clinic.unitId };
    expect((await clinic.owner.post(url('/inventory/movements'), { ...base, type: 'in', quantity: '5', lotCode: 'A', expiresOn: '2030-04-01' })).status).toBe(201);
    expect((await clinic.owner.post(url('/inventory/movements'), { ...base, type: 'in', quantity: '5', lotCode: 'B', expiresOn: '2030-05-01' })).status).toBe(201);
    expect((await clinic.owner.post(url('/inventory/movements'), { ...base, type: 'out', quantity: '6' })).status).toBe(201);
    let lots = await clinic.owner.get(url(`/inventory/items/${stocked}/lots?unitId=${clinic.unitId}`));
    expect(lots.body).toHaveLength(1); expect(lots.body[0]).toMatchObject({ lotCode: 'B', balance: '4.000' });
    expect((await clinic.owner.post(url('/inventory/transfers'), { itemId: stocked, fromUnitId: clinic.unitId, toUnitId: hiddenUnit, quantity: '4' })).status).toBe(201);
    lots = await clinic.owner.get(url(`/inventory/items/${stocked}/lots?unitId=${clinic.unitId}`)); expect(lots.body).toEqual([]);
    const destination = await clinic.owner.get(url(`/inventory/items/${stocked}/lots?unitId=${hiddenUnit}`));
    expect(destination.body).toHaveLength(1); expect(destination.body[0]).toMatchObject({ lotCode: 'B', balance: '4.000' });
    expect((await manager.get(url(`/inventory/items/${stocked}/lots?unitId=${hiddenUnit}`))).status).toBe(404);
    expect((await clinic.owner.post(url('/inventory/movements'), { ...base, type: 'out', quantity: '1' })).status).toBe(422);
  });

  it('lab orders reject foreign professionals and another patient treatment item', async () => {
    const professional = await createProfessional(foreign, 'Foreign professional');
    const anotherPatient = await createPatient(clinic.owner, clinic.orgId, 'Another Patient');
    const plan = (await clinic.owner.post(url(`/patients/${anotherPatient}/treatment-plans`), { title: 'Another patient plan', unitId: clinic.unitId })).body.id;
    const stage = (await clinic.owner.post(url(`/treatment-plans/${plan}/items`), { description: 'Crown' })).body.id;
    const order = { unitId: clinic.unitId, patientId: patient, laboratoryId: lab, work: 'Crown work', dueDate: '2030-03-20' };
    expect((await clinic.owner.post(url('/labs/orders'), { ...order, professionalId: professional })).status).toBe(404);
    expect((await clinic.owner.post(url('/labs/orders'), { ...order, treatmentItemId: stage })).status).toBe(404);
    expect((await clinic.owner.post(url('/labs/orders'), { ...order, unitId: foreign.unitId })).status).toBe(404);
    expect((await clinic.owner.post(url('/labs/orders'), { ...order, documentIds: [stage] })).status).toBe(404);
    const hidden = await clinic.owner.post(url('/labs/orders'), { ...order, unitId: hiddenUnit });
    expect(hidden.status).toBe(201);
    expect((await manager.get(url(`/labs/orders/${hidden.body.id}`))).status).toBe(404);
    expect((await manager.get(url('/labs/orders'))).body).toEqual([]);
  });
});
