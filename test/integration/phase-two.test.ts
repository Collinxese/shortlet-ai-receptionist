import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { lagosMidnight } from '../../src/services/calendar.js';
import { TenantRepository } from '../../src/services/tenant-repository.js';
import type { AuthContext, PublicUser } from '../../src/services/authentication.js';
import { isolatedDatabase } from './database.js';

type Account = { accessToken: string; user: PublicUser };
const details = {
  name: 'Lekki apartment', area: 'Lekki', address: 'Test address', description: 'Test description',
  bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: ['Wi-Fi', 'Air conditioning'],
  baseNightlyPriceKobo: 5_000_000, weekendNightlyPriceKobo: 6_000_000, cleaningFeeKobo: 500_000,
  otherFees: [{ label: 'Parking per stay', amountKobo: 100_000 }], minimumStayNights: 1,
  standardCheckIn: '14:00', standardCheckOut: '11:00',
  earlyCheckInAllowed: true, earlyCheckInFrom: '09:00', earlyCheckInFeeKobo: 1_000_000,
  earlyCheckInRules: 'Subject to operator approval', lateCheckOutAllowed: true,
  lateCheckOutUntil: '17:00', lateCheckOutFeeKobo: 1_500_000, lateCheckOutRules: 'Subject to availability',
  cancellationPolicy: 'Contact operator before cancellation', refundPolicy: 'Refunds require operator review'
};

test('Phase 2 API and repository against migrated PostgreSQL', async (t) => {
  let app: FastifyInstance | undefined;
  t.after(async () => { await app?.close(); });
  const { db, databaseUrl, deploy } = await isolatedDatabase(t);
  assert.match(deploy(), /All migrations have been successfully applied/);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_RATE_LIMIT_MAX: '30' }), { db, logger: false });
  let client = 0;
  const api = app;
  const request = (method: HTTPMethods, path: string, account?: Account, payload?: object) => api.inject({
    method, url: `/api${path}`, remoteAddress: `198.51.100.${client++ % 250 + 1}`,
    headers: account ? { authorization: `Bearer ${account.accessToken}` } : {}, payload
  });
  const password = 'phase-two-test-only-password';
  const register = async (label: string): Promise<Account> => {
    const response = await request('POST', '/auth/register', undefined, { tenantName: label, name: label, email: `${label}@example.com`, password });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const a = await register('property-owner-a');
  const b = await register('property-owner-b');
  const staff = async (role: 'MANAGER' | 'RECEPTIONIST'): Promise<Account> => {
    const email = `${role.toLowerCase()}@example.com`;
    assert.equal((await request('POST', '/team', a, { name: role, email, password, role })).statusCode, 201);
    const login = await request('POST', '/auth/login', undefined, { email, password });
    assert.equal(login.statusCode, 200);
    return login.json();
  };
  const manager = await staff('MANAGER');
  const receptionist = await staff('RECEPTIONIST');
  const createProperty = async (account = a, patch = {}) => {
    const response = await request('POST', '/properties', account, { ...details, ...patch });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().property as { id: string; tenantId: string; [key: string]: unknown };
  };
  const propertyA = await createProperty();
  const propertyB = await createProperty(b);
  const path = (id = propertyA.id) => `/properties/${id}`;
  const blockBody = { startDate: '2026-11-10', endDate: '2026-11-12', reason: 'Maintenance' };
  const priceBody = { startDate: '2026-11-07', endDate: '2026-11-08', label: 'Event rate', nightlyPriceKobo: 9_000_000 };
  const availability = (id: string, checkIn: string, checkOut: string, actor = a) =>
    request('GET', `${path(id)}/availability?checkIn=${checkIn}&checkOut=${checkOut}`, actor);

  await t.test('property CRUD persists configuration and integer kobo and supports pagination and soft deactivation', async () => {
    assert.equal(propertyA.tenantId, a.user.tenantId);
    assert.equal(propertyA.baseNightlyPriceKobo, details.baseNightlyPriceKobo);
    assert.deepEqual(propertyA.otherFees, details.otherFees);
    const stored = await db.property.findUniqueOrThrow({ where: { id: propertyA.id } });
    assert.equal(stored.weekendNightlyPriceKobo, 6_000_000n);
    const read = await request('GET', path(), receptionist);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().property.amenities, details.amenities);
    const updated = await request('PATCH', path(), manager, {
      name: 'Updated apartment', bathrooms: 3, otherFees: [{ label: 'Laundry per stay', amountKobo: 200_000 }], refundPolicy: 'Updated refund policy'
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().property.bathrooms, 3);
    assert.equal((await db.propertyFee.count({ where: { tenantId: a.user.tenantId, propertyId: propertyA.id } })), 1);
    assert.equal((await request('PATCH', path(), manager, { otherFees: [] })).statusCode, 200);
    assert.equal((await db.propertyFee.count({ where: { tenantId: a.user.tenantId, propertyId: propertyA.id } })), 0);
    const extra = await createProperty(a, { name: 'Deactivate me' });
    const first = await request('GET', '/properties?limit=1&offset=0', a);
    const second = await request('GET', '/properties?limit=1&offset=1', a);
    assert.notEqual(first.json().properties[0].id, second.json().properties[0].id);
    assert.equal((await request('DELETE', path(extra.id), manager)).statusCode, 200);
    assert.equal((await request('GET', path(extra.id), receptionist)).json().property.isActive, false);
    assert.equal((await request('GET', '/properties?status=inactive', a)).json().properties[0].id, extra.id);
    assert.ok((await request('GET', '/properties', a)).json().properties.every((item: { isActive: boolean }) => item.isActive));
    assert.equal((await request('GET', '/properties?status=all', a)).json().properties.length, 2);
    assert.equal((await availability(extra.id, '2026-12-01', '2026-12-03')).json().available, false);
    assert.equal((await request('POST', `${path(extra.id)}/blocks`, a, blockBody)).statusCode, 409);
    assert.equal((await request('PATCH', path(extra.id), a, { isActive: true })).statusCode, 200);
  });

  await t.test('all property routes require authentication', async () => {
    const routes: [HTTPMethods, string][] = [
      ['GET', '/properties'], ['POST', '/properties'], ['GET', path()], ['PATCH', path()], ['DELETE', path()],
      ['GET', `${path()}/availability?checkIn=2026-11-10&checkOut=2026-11-12`], ['GET', `${path()}/blocks`],
      ['POST', `${path()}/blocks`], ['DELETE', `${path()}/blocks/${propertyA.id}`],
      ['GET', `${path()}/price-overrides`], ['POST', `${path()}/price-overrides`], ['DELETE', `${path()}/price-overrides/${propertyA.id}`]
    ];
    for (const [method, url] of routes) assert.equal((await request(method, url)).statusCode, 401, `${method} ${url}`);
  });

  await t.test('receptionists may view properties and calendars but cannot change any configuration', async () => {
    for (const url of ['/properties', path(), `${path()}/blocks`, `${path()}/price-overrides`, `${path()}/availability?checkIn=2026-11-10&checkOut=2026-11-12`]) {
      assert.equal((await request('GET', url, receptionist)).statusCode, 200, url);
    }
    for (const [method, url, payload] of [
      ['POST', '/properties', details], ['PATCH', path(), { name: 'Denied' }], ['DELETE', path(), undefined],
      ['POST', `${path()}/blocks`, blockBody], ['DELETE', `${path()}/blocks/${propertyA.id}`, undefined],
      ['POST', `${path()}/price-overrides`, priceBody], ['DELETE', `${path()}/price-overrides/${propertyA.id}`, undefined]
    ] as [HTTPMethods, string, object | undefined][]) assert.equal((await request(method, url, receptionist, payload)).statusCode, 403, `${method} ${url}`);
    const repo = new TenantRepository(db, { user: receptionist.user, sessionId: 'test-only' });
    await assert.rejects(repo.createBlock(propertyA.id, blockBody), { message: 'FORBIDDEN' });
    await assert.rejects(repo.updateProperty(propertyA.id, { name: 'Denied' }), { message: 'FORBIDDEN' });
    await assert.rejects(repo.createPriceOverride(propertyA.id, priceBody), { message: 'FORBIDDEN' });
  });

  await t.test('every property lookup and mutation is isolated in both tenant directions', async () => {
    for (const [actor, foreign] of [[a, propertyB], [b, propertyA]] as const) {
      const endpoints: [HTTPMethods, string, object | undefined][] = [
        ['GET', path(foreign.id), undefined], ['PATCH', path(foreign.id), { name: 'Denied' }], ['DELETE', path(foreign.id), undefined],
        ['GET', `${path(foreign.id)}/availability?checkIn=2026-11-10&checkOut=2026-11-12`, undefined],
        ['GET', `${path(foreign.id)}/blocks`, undefined], ['POST', `${path(foreign.id)}/blocks`, blockBody],
        ['GET', `${path(foreign.id)}/price-overrides`, undefined], ['POST', `${path(foreign.id)}/price-overrides`, priceBody]
      ];
      for (const [method, url, payload] of endpoints) {
        const result = await request(method, url, actor, payload);
        assert.equal(result.statusCode, 404, result.body);
        assert.deepEqual(result.json(), { error: 'NOT_FOUND' });
      }
      const list = await request('GET', '/properties?status=all', actor);
      assert.ok(list.json().properties.every((item: { tenantId: string }) => item.tenantId === actor.user.tenantId));
    }
    const repo = new TenantRepository(db, { user: a.user, sessionId: 'test-only' });
    await assert.rejects(repo.property(propertyB.id), { message: 'NOT_FOUND' });
    await assert.rejects(repo.removeBlock(propertyB.id, propertyA.id), { message: 'NOT_FOUND' });
    assert.equal((await request('GET', `/properties/c${'z'.repeat(24)}`, a)).statusCode, 404);
  });

  await t.test('validation rejects malformed inputs, tenant injection, unsafe prices, and merged rule conflicts', async () => {
    for (const patch of [
      { bedrooms: -1 }, { bathrooms: 0.5 }, { baseNightlyPriceKobo: 1.1 }, { baseNightlyPriceKobo: '100' },
      { weekendNightlyPriceKobo: -1 }, { cleaningFeeKobo: 100_000_000_001 }, { minimumStayNights: 0 },
      { amenities: ['Wi-Fi', 'wi-fi'] }, { otherFees: [{ label: '', amountKobo: 1 }] },
      { name: ' ' }, { maxGuests: 0 }, { standardCheckOut: '25:00' }, { tenantId: b.user.tenantId }, { currency: 'USD' }
    ]) assert.equal((await request('POST', '/properties', a, { ...details, ...patch })).statusCode, 400, JSON.stringify(patch));
    assert.equal((await request('PATCH', path(), a, {})).statusCode, 400);
    assert.equal((await request('PATCH', path(), a, { standardCheckIn: '08:00' })).statusCode, 400);
    assert.equal((await request('PATCH', path(), a, { tenantId: b.user.tenantId })).statusCode, 400);
    assert.equal((await request('GET', `/properties?tenantId=${b.user.tenantId}`, a)).statusCode, 400);
    assert.equal((await request('GET', '/properties/invalid-id', a)).statusCode, 400);
    for (const endpoint of ['blocks', 'price-overrides']) {
      const base = endpoint === 'blocks' ? blockBody : priceBody;
      for (const patch of [{ endDate: base.startDate }, { startDate: '2026-02-30' }, { endDate: '2029-01-01' }, { tenantId: b.user.tenantId }, { propertyId: propertyB.id }]) {
        const response = await request('POST', `${path()}/${endpoint}`, a, { ...base, ...patch });
        assert.equal(response.statusCode, 400, response.body);
        assert.deepEqual(response.json(), { error: 'INVALID_REQUEST' });
      }
      assert.equal((await request('GET', `${path()}/${endpoint}?startDate=2026-11-10`, a)).statusCode, 400);
    }
    assert.equal((await availability(propertyA.id, '2026-11-10', '2026-11-10')).statusCode, 400);
    assert.equal((await availability(propertyA.id, '2026-02-30', '2026-03-02')).statusCode, 400);
    const spoof = await api.inject({ url: `/api${path()}`, headers: { authorization: `Bearer ${a.accessToken}`, 'x-tenant-id': b.user.tenantId } });
    assert.equal(spoof.json().property.tenantId, a.user.tenantId);
  });

  let blockA = '';
  await t.test('operator blocks use half-open Lagos dates and reject every form of overlap', async () => {
    const created = await request('POST', `${path()}/blocks`, manager, blockBody);
    assert.equal(created.statusCode, 201, created.body);
    blockA = created.json().block.id;
    assert.equal(created.json().block.startAt, '2026-11-09T23:00:00.000Z');
    assert.equal(created.json().block.endAt, '2026-11-11T23:00:00.000Z');
    for (const [startDate, endDate] of [
      ['2026-11-10', '2026-11-12'], ['2026-11-10', '2026-11-11'], ['2026-11-09', '2026-11-13'],
      ['2026-11-09', '2026-11-11'], ['2026-11-11', '2026-11-13']
    ]) assert.equal((await request('POST', `${path()}/blocks`, a, { startDate, endDate, reason: 'Overlap' })).statusCode, 409);
    assert.equal((await availability(propertyA.id, '2026-11-10', '2026-11-12')).json().available, false);
    assert.equal((await availability(propertyA.id, '2026-11-12', '2026-11-14')).json().available, true);
    assert.equal((await availability(propertyA.id, '2026-11-08', '2026-11-10')).json().available, true);
    const adjacent = await request('POST', `${path()}/blocks`, a, { ...blockBody, startDate: '2026-11-12', endDate: '2026-11-14' });
    assert.equal(adjacent.statusCode, 201);
    const filtered = await request('GET', `${path()}/blocks?startDate=2026-11-12&endDate=2026-11-14&limit=10`, a);
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().blocks.length, 1);
    assert.equal(filtered.json().blocks[0].id, adjacent.json().block.id);
    assert.equal((await request('DELETE', `${path()}/blocks/${adjacent.json().block.id}`, manager)).statusCode, 204);
  });

  await t.test('child block and override IDs must match both the session tenant and path property', async () => {
    const foreignBlock = await request('POST', `${path(propertyB.id)}/blocks`, b, blockBody);
    assert.equal(foreignBlock.statusCode, 201);
    const foreignRule = await request('POST', `${path(propertyB.id)}/price-overrides`, b, priceBody);
    assert.equal(foreignRule.statusCode, 201);
    for (const [url, actor] of [
      [`${path()}/blocks/${foreignBlock.json().block.id}`, a], [`${path(propertyB.id)}/blocks/${blockA}`, b],
      [`${path()}/price-overrides/${foreignRule.json().priceOverride.id}`, a]
    ] as const) assert.equal((await request('DELETE', url, actor)).statusCode, 404);
    const other = await createProperty();
    assert.equal((await request('DELETE', `${path(other.id)}/blocks/${blockA}`, a)).statusCode, 404);
    const external = await db.availabilityBlock.create({ data: {
      tenantId: a.user.tenantId, propertyId: other.id, source: 'external', reason: 'Fixture',
      startDate: lagosMidnight('2026-12-01'), endDate: lagosMidnight('2026-12-03')
    } });
    assert.equal((await request('DELETE', `${path(other.id)}/blocks/${external.id}`, a)).statusCode, 404);
    assert.equal((await request('GET', `${path(other.id)}/blocks`, a)).json().blocks.length, 0);
    assert.equal((await availability(other.id, '2026-12-01', '2026-12-03')).json().available, false);
    assert.equal((await request('POST', `${path(other.id)}/blocks`, a, { ...blockBody, startDate: '2026-12-01', endDate: '2026-12-02' })).statusCode, 409);
    assert.equal((await request('DELETE', `${path()}/blocks/${blockA}`, manager)).statusCode, 204);
    assert.equal((await request('DELETE', `${path()}/blocks/${blockA}`, manager)).statusCode, 404);
    assert.equal((await availability(propertyA.id, '2026-11-10', '2026-11-12')).json().available, true);
  });

  await t.test('weekday/weekend rates and optional date overrides are persisted, scoped and removable', async () => {
    const before = await availability(propertyA.id, '2026-11-05', '2026-11-09');
    assert.deepEqual(before.json().nightlyPrices.map((item: { nightlyPriceKobo: number }) => item.nightlyPriceKobo), [5_000_000, 6_000_000, 6_000_000, 5_000_000]);
    const created = await request('POST', `${path()}/price-overrides`, manager, priceBody);
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().priceOverride.id;
    assert.equal((await request('POST', `${path()}/price-overrides`, a, priceBody)).statusCode, 409);
    assert.equal((await request('GET', `${path()}/price-overrides`, receptionist)).json().priceOverrides[0].id, id);
    assert.equal((await request('GET', `${path()}/price-overrides?startDate=2026-11-08&endDate=2026-11-09`, a)).json().priceOverrides.length, 0);
    assert.equal((await availability(propertyA.id, '2026-11-07', '2026-11-08')).json().nightlyPrices[0].nightlyPriceKobo, 9_000_000);
    assert.equal((await availability(propertyA.id, '2026-11-08', '2026-11-09')).json().nightlyPrices[0].nightlyPriceKobo, 5_000_000);
    assert.equal((await request('DELETE', `${path()}/price-overrides/${id}`, manager)).statusCode, 204);
    assert.equal((await availability(propertyA.id, '2026-11-07', '2026-11-08')).json().nightlyPrices[0].nightlyPriceKobo, 6_000_000);
  });

  await t.test('simultaneous API block and price-override creation allows only one conflicting writer', async () => {
    for (const endpoint of ['blocks', 'price-overrides']) {
      const payload = endpoint === 'blocks' ? { ...blockBody, startDate: '2027-01-01', endDate: '2027-01-04' } :
        { ...priceBody, startDate: '2027-01-01', endDate: '2027-01-04' };
      const results = await Promise.all([request('POST', `${path()}/${endpoint}`, a, payload), request('POST', `${path()}/${endpoint}`, manager, payload)]);
      assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409]);
    }
    assert.equal(await db.availabilityBlock.count({ where: { tenantId: a.user.tenantId, propertyId: propertyA.id, startDate: lagosMidnight('2027-01-01') } }), 1);
  });

  await t.test('existing booking states and active holds affect calendar reads without creating booking workflows', async () => {
    const room = await createProperty(a, { minimumStayNights: 2 });
    // Only test fixtures write bookings. Actual times normalize to occupied Lagos nights.
    const booking = await db.booking.create({ data: {
      tenantId: a.user.tenantId, propertyId: room.id, guestPhone: 'test-only-private', guestCount: 1,
      checkIn: new Date('2027-02-10T14:00:00+01:00'), checkOut: new Date('2027-02-12T11:00:00+01:00'),
      quoteTotalKobo: 10_000_000, status: 'CONFIRMED'
    } });
    for (const [status, expected] of [
      ['CONFIRMED', false], ['PAYMENT_REVIEW', false], ['VERIFICATION_PENDING', false],
      ['REQUESTED', true], ['EXPIRED', true], ['CANCELLED', true], ['PAID_CONFLICT', true],
      ['REFUND_PENDING', true], ['REFUNDED', true], ['REFUND_DUE', true]
    ] as const) {
      await db.booking.update({ where: { id: booking.id }, data: { status } });
      const response = await availability(room.id, '2027-02-10', '2027-02-12');
      assert.equal(response.json().available, expected, status);
      assert.equal(response.body.includes('test-only-private'), false);
      assert.equal(response.body.includes(booking.id), false);
    }
    for (const [expiry, expected] of [[Date.now() + 3_600_000, false], [Date.now() - 1, true]] as const) {
      await db.booking.update({ where: { id: booking.id }, data: { status: 'HELD', holdExpiresAt: new Date(expiry) } });
      assert.equal((await availability(room.id, '2027-02-10', '2027-02-12')).json().available, expected);
    }
    await db.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
    assert.equal((await availability(room.id, '2027-02-12', '2027-02-14')).json().available, true);
    const short = await availability(room.id, '2027-02-15', '2027-02-16');
    assert.equal(short.json().calendarAvailable, true);
    assert.equal(short.json().minimumStayMet, false);
    assert.equal(short.json().available, false);
    assert.equal((await availability(propertyA.id, '2027-02-10', '2027-02-12')).json().available, true);
    assert.equal((await availability(propertyB.id, '2027-02-10', '2027-02-12', b)).json().available, true);
  });

  await t.test('database constraints independently prevent overlaps, invalid values and cross-tenant fee ownership', async () => {
    const room = await createProperty();
    const rawBlock = { tenantId: a.user.tenantId, propertyId: room.id, reason: 'Raw fixture', startDate: lagosMidnight('2027-03-01'), endDate: lagosMidnight('2027-03-04') };
    const outcomes = await Promise.allSettled([db.availabilityBlock.create({ data: rawBlock }), db.availabilityBlock.create({ data: rawBlock })]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(failure?.status === 'rejected');
    // PostgreSQL may abort a simultaneous exclusion insertion with a deadlock.
    // Either result must leave one row, and retrying must hit the actual exclusion.
    assert.match(String(failure.reason), /AvailabilityBlock_no_overlap|40P01/);
    await assert.rejects(db.availabilityBlock.create({ data: rawBlock }), /AvailabilityBlock_no_overlap/);
    await assert.rejects(db.availabilityBlock.create({ data: { ...rawBlock, endDate: rawBlock.startDate } }));
    await assert.rejects(db.property.update({ where: { id: room.id }, data: { baseNightlyPriceKobo: -1 } }));
    await assert.rejects(db.property.update({ where: { id: room.id }, data: { standardCheckIn: '24:00' } }));
    await assert.rejects(db.propertyFee.create({ data: { tenantId: a.user.tenantId, propertyId: propertyB.id, label: 'Denied', amountKobo: 1 } }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003');
    await assert.rejects(db.priceRule.create({ data: { tenantId: a.user.tenantId, propertyId: room.id, label: 'Denied', nightlyPriceKobo: -1 } }));
  });

  await t.test('audit events contain actor, timestamp and relevant before/after changes and roll back with mutations', async () => {
    const events = await db.auditLog.findMany({ where: { tenantId: a.user.tenantId, entityType: { in: ['Property', 'AvailabilityBlock', 'PriceRule'] } } });
    for (const action of ['property.created', 'property.updated', 'property.deactivated', 'availability.block.created', 'availability.block.removed', 'pricing.override.created', 'pricing.override.removed']) {
      assert.ok(events.some((event) => event.action === action), action);
    }
    const changed = events.find((event) => event.action === 'property.updated' && event.entityId === propertyA.id &&
      (event.after as { name?: string })?.name === 'Updated apartment');
    assert.ok(changed);
    assert.equal((changed.before as { name: string }).name, details.name);
    assert.equal(changed.actorId, manager.user.id);
    assert.ok(changed.createdAt instanceof Date);
    assert.equal(JSON.stringify(events).includes(password), false);
    const count = await db.property.count({ where: { tenantId: a.user.tenantId } });
    const auth: AuthContext = { user: { ...a.user, id: 'c' + 'z'.repeat(24) }, sessionId: 'test-only' };
    const invalidActor = new TenantRepository(db, auth);
    await assert.rejects(invalidActor.createProperty(details));
    assert.equal(await db.property.count({ where: { tenantId: a.user.tenantId } }), count);
  });

  await t.test('health and readiness remain functional after all migrations', async () => {
    assert.equal((await request('GET', '/health')).statusCode, 200);
    assert.equal((await request('GET', '/ready')).statusCode, 200);
  });
});
