import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HTTPMethods, FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { AuthContext, PublicUser } from '../../src/services/authentication.js';
import { BookingService } from '../../src/services/booking-service.js';
import { lagosMidnight } from '../../src/services/calendar.js';
import { isolatedDatabase } from './database.js';

type Account = { accessToken: string; user: PublicUser };
test('Phase 3 booking engine against isolated migrated PostgreSQL', async (t) => {
  let app: FastifyInstance | undefined;
  t.after(async () => { await app?.close(); });
  const { db, databaseUrl, deploy } = await isolatedDatabase(t);
  assert.match(deploy(), /All migrations have been successfully applied/);
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_RATE_LIMIT_MAX: '30' }), { db, logger: false });
  let sequence = 0;
  const request = (method: HTTPMethods, path: string, actor?: Account, payload?: object, key?: string) => app!.inject({
    method, url: `/api${path}`, remoteAddress: `198.51.${Math.floor(sequence / 200) % 250}.${++sequence % 200 + 1}`,
    headers: { ...(actor ? { authorization: `Bearer ${actor.accessToken}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, payload
  });
  const password = 'phase-three-test-password';
  const register = async (name: string): Promise<Account> => {
    const result = await request('POST', '/auth/register', undefined, { tenantName: name, name, email: `${name}@example.com`, password });
    assert.equal(result.statusCode, 201, result.body);
    return result.json();
  };
  const a = await register('booking-owner-a'), b = await register('booking-owner-b');
  const staff = async (role: 'MANAGER' | 'RECEPTIONIST'): Promise<Account> => {
    const email = `${role.toLowerCase()}@example.com`;
    assert.equal((await request('POST', '/team', a, { name: role, email, password, role })).statusCode, 201);
    return (await request('POST', '/auth/login', undefined, { email, password })).json();
  };
  const manager = await staff('MANAGER'), receptionist = await staff('RECEPTIONIST');
  const context = (account = a): AuthContext => ({ user: account.user, sessionId: 'test-only' });
  const room = (actor = a, patch = {}) => db.property.create({ data: { tenantId: actor.user.tenantId,
    name: 'Booking room', area: 'Lekki', bedrooms: 1, bathrooms: 1, maxGuests: 4,
    baseNightlyPriceKobo: 10001n, weekendNightlyPriceKobo: 20003n, cleaningFeeKobo: 101n, ...patch } });
  const input = (propertyId: string, patch = {}) => ({ propertyId, checkIn: '2027-01-10', checkOut: '2027-01-12',
    guestName: 'Test guest', guestPhone: `+23480${String(++sequence).padStart(8, '0')}`, guestCount: 2, ...patch });
  const create = (body: object, actor = a, key = `phase3-key-${++sequence}`, path = '/holds') => request('POST', path, actor, body, key);
  const availability = (propertyId: string, checkIn = '2027-01-10', checkOut = '2027-01-12') =>
    request('GET', `/properties/${propertyId}/availability?checkIn=${checkIn}&checkOut=${checkOut}`, a);

  await t.test('backend quote snapshot, reference, immutable terms and audit are persisted atomically', async () => {
    const property = await room(a, { cancellationPolicy: 'Original policy' });
    await db.propertyFee.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, label: 'Parking', amountKobo: 103 } });
    await db.priceRule.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, label: 'Event', nightlyPriceKobo: 30007,
      startDate: lagosMidnight('2026-11-07'), endDate: lagosMidnight('2026-11-08') } });
    const body = input(property.id, { checkIn: '2026-11-05', checkOut: '2026-11-09', guestPhone: '0801 234 5678' });
    const created = await create(body);
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json().booking;
    assert.equal(booking.quoteTotalKobo, 70216);
    assert.equal(booking.guestPhone, '+2348012345678');
    assert.equal(booking.confirmed, false);
    assert.equal(booking.status, 'HELD');
    assert.equal(Date.parse(booking.holdExpiresAt) - Date.parse(booking.holdStartedAt), 60 * 60_000);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(stored.quoteTotalKobo, 70216n);
    assert.equal(stored.reference, booking.reference);
    assert.deepEqual(stored.quoteSnapshot, booking.quoteSnapshot);
    assert.equal(stored.checkIn.toISOString(), '2026-11-04T23:00:00.000Z');
    assert.equal((await request('PATCH', `/properties/${property.id}`, manager, { baseNightlyPriceKobo: 99999, cancellationPolicy: 'New policy' })).statusCode, 200);
    const read = await request('GET', `/bookings/${booking.id}`, receptionist);
    assert.deepEqual(read.json().booking.quoteSnapshot, booking.quoteSnapshot);
    await assert.rejects(db.booking.update({ where: { id: booking.id }, data: { quoteTotalKobo: 1 } }), /Booking terms are immutable/);
    const event = await db.auditLog.findFirstOrThrow({ where: { entityId: booking.id, action: 'booking.held' } });
    assert.equal(event.tenantId, a.user.tenantId);
    assert.equal(event.actorId, a.user.id);
    assert.equal(JSON.stringify(event).includes('2348012345678'), false);
  });

  await t.test('requests do not occupy dates, list summaries omit contact details, routine roles may cancel', async () => {
    const property = await room();
    const created = await create(input(property.id), receptionist, undefined, '/bookings');
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json().booking;
    assert.equal(booking.status, 'REQUESTED');
    assert.equal(booking.holdExpiresAt, null);
    assert.equal((await availability(property.id)).json().available, true);
    const listed = await request('GET', `/bookings?propertyId=${property.id}&status=REQUESTED&limit=1`, manager);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().bookings[0].id, booking.id);
    assert.equal('guestPhone' in listed.json().bookings[0], false);
    assert.equal('quoteSnapshot' in listed.json().bookings[0], false);
    assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, receptionist, { reason: 'Guest changed plans' })).json().booking.status, 'CANCELLED');
    assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, a, { reason: 'Again' })).statusCode, 409);
  });

  await t.test('equivalent idempotency replay returns original result, changed input conflicts, and concurrent duplicates create once', async () => {
    const property = await room();
    const body = input(property.id, { guestPhone: '08023456789' });
    const key = 'duplicate-key-concurrent';
    const results = await Promise.all([create(body, a, key), create({ ...body, guestPhone: '+2348023456789' }, a, key)]);
    assert.deepEqual(results.map((r) => r.statusCode), [201, 201]);
    assert.deepEqual(results[0]!.json(), results[1]!.json());
    const booking = results[0]!.json().booking;
    assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 1);
    assert.equal(await db.bookingOperation.count({ where: { bookingId: booking.id } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.held' } }), 1);
    const conflict = await create({ ...body, guestCount: 3 }, a, key);
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { error: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, a, { reason: 'Cancel' })).statusCode, 200);
    const replay = await create(body, a, key);
    assert.deepEqual(replay.json(), results[0]!.json());
    assert.equal((await request('GET', `/bookings/${booking.id}`, a)).json().booking.status, 'CANCELLED');
  });

  await t.test('concurrent overlapping holds have one winner; adjacent half-open stays both succeed', async () => {
    const property = await room();
    const results = await Promise.all([create(input(property.id)), create(input(property.id))]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409], results.map((r) => r.body).join('\n'));
    assert.equal(await db.booking.count({ where: { propertyId: property.id, status: 'HELD' } }), 1);
    assert.equal(await db.auditLog.count({ where: { action: 'booking.held', after: { path: ['propertyId'], equals: property.id } } }), 1);
    const adjacent = await Promise.all([
      create(input(property.id, { checkIn: '2027-01-08', checkOut: '2027-01-10' })),
      create(input(property.id, { checkIn: '2027-01-12', checkOut: '2027-01-14' }))
    ]);
    assert.deepEqual(adjacent.map((r) => r.statusCode), [201, 201], adjacent.map((r) => r.body).join('\n'));
  });

  await t.test('concurrent booking and operator block use the same lock and cannot both win', async () => {
    for (let i = 0; i < 3; i++) {
      const property = await room();
      const results = await Promise.all([
        create(input(property.id)), request('POST', `/properties/${property.id}/blocks`, manager, { startDate: '2027-01-10', endDate: '2027-01-12', reason: 'Maintenance' })
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409], results.map((r) => r.body).join('\n'));
      assert.equal(await db.booking.count({ where: { propertyId: property.id } }) + await db.availabilityBlock.count({ where: { propertyId: property.id } }), 1);
    }
  });

  await t.test('database triggers also reject concurrent raw cross-table writes and duplicate tenant-wide guest holds', async () => {
    const property = await room();
    const data = { tenantId: a.user.tenantId, propertyId: property.id, guestPhone: '+2348034567890', guestCount: 1,
      checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'), quoteTotalKobo: 20002,
      status: 'HELD' as const, holdExpiresAt: new Date(Date.now() + 3600000) };
    const results = await Promise.allSettled([
      db.booking.create({ data }), db.availabilityBlock.create({ data: { tenantId: a.user.tenantId, propertyId: property.id,
        startDate: data.checkIn, endDate: data.checkOut, reason: 'Raw concurrent block' } })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await db.booking.count({ where: { propertyId: property.id } }) + await db.availabilityBlock.count({ where: { propertyId: property.id } }), 1);
    const rawRoom = await room();
    const rawOverlaps = await Promise.allSettled([
      db.booking.create({ data: { ...data, propertyId: rawRoom.id, guestPhone: '+2348070000001' } }),
      db.booking.create({ data: { ...data, propertyId: rawRoom.id, guestPhone: '+2348070000002' } })
    ]);
    assert.equal(rawOverlaps.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await db.booking.count({ where: { propertyId: rawRoom.id } }), 1);
    const [rawRoom1, rawRoom2] = await Promise.all([room(), room()]);
    const rawPhones = await Promise.allSettled([rawRoom1, rawRoom2].map((p) => db.booking.create({
      data: { ...data, propertyId: p.id, guestPhone: '+2348070000003' }
    })));
    assert.equal(rawPhones.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await db.booking.count({ where: { tenantId: a.user.tenantId, guestPhone: '+2348070000003' } }), 1);
    await assert.rejects(db.$transaction((tx) => tx.booking.create({ data: {
      ...data, propertyId: rawRoom2.id, guestPhone: '+2348070000004', checkIn: lagosMidnight('2027-02-01'), checkOut: lagosMidnight('2027-02-02')
    } }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }), /Occupancy_isolation/);
    const [room1, room2] = await Promise.all([room(), room()]);
    const phone = '+2348045678901';
    const samePhone = await Promise.all([create(input(room1.id, { guestPhone: phone })), create(input(room2.id, { guestPhone: phone }))]);
    assert.deepEqual(samePhone.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(samePhone.find((r) => r.statusCode === 409)!.json().error, 'GUEST_ACTIVE_HOLD');
    // Same phone in another tenant is independent.
    const foreign = await room(b);
    assert.equal((await create(input(foreign.id, { guestPhone: phone }), b)).statusCode, 201);
  });

  await t.test('extension is exactly fifteen minutes, atomic once, and cancellation releases occupancy', async () => {
    const property = await room();
    const created = await create(input(property.id), receptionist);
    assert.equal(created.statusCode, 201, created.body);
    const booking = created.json().booking;
    const results = await Promise.all([request('POST', `/bookings/${booking.id}/extend`, receptionist), request('POST', `/bookings/${booking.id}/extend`, manager)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    const updated = results.find((r) => r.statusCode === 200)!.json().booking;
    assert.equal(Date.parse(updated.holdExpiresAt) - Date.parse(booking.holdExpiresAt), 15 * 60_000);
    assert.equal(updated.holdExtensionCount, 1);
    assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.hold_extended' } }), 1);
    assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, receptionist, { reason: 'Guest cancellation' })).statusCode, 200);
    assert.equal((await availability(property.id)).json().available, true);
  });

  await t.test('expiry boundary is exclusive and expired/early-expiry mutations do not change an active hold', async () => {
    const property = await room();
    const created = await create(input(property.id));
    const booking = created.json().booking;
    const exact = new BookingService(db, context(), () => new Date(booking.holdExpiresAt));
    assert.equal((await exact.get(booking.id)).effectiveStatus, 'EXPIRED');
    await assert.rejects(exact.extend(booking.id), (e: unknown) => (e as { code: string }).code === 'HOLD_EXPIRED');
    await assert.rejects(new BookingService(db, context()).expireHold(booking.id), (e: unknown) => (e as { code: string }).code === 'HOLD_NOT_EXPIRED');
    await assert.rejects(db.booking.update({ where: { id: booking.id }, data: { status: 'EXPIRED' } }), /Booking_expiry_invalid/);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(stored.status, 'HELD');
    assert.equal(stored.holdExtensionCount, 0);
  });

  await t.test('idempotency keys are scoped by tenant and creation operation', async () => {
    const propertyA = await room(), propertyB = await room(b);
    const key = 'shared-key-across-operations';
    const bodyA = input(propertyA.id), bodyB = input(propertyB.id);
    const requested = await create(bodyA, a, key, '/bookings');
    const heldA = await create(bodyA, a, key), heldB = await create(bodyB, b, key);
    assert.deepEqual([requested.statusCode, heldA.statusCode, heldB.statusCode], [201, 201, 201]);
    assert.equal(await db.bookingOperation.count({ where: { key } }), 3);
    assert.notEqual(requested.json().booking.id, heldA.json().booking.id);
  });

  await t.test('expiry is evaluated by timestamps, not cleanup; confirmed records cannot expire or cancel in this phase', async () => {
    const property = await room();
    const past = new Date(Date.now() - 3_600_001);
    const service = new BookingService(db, context(), () => past);
    const body = input(property.id, { guestPhone: '+2348056789012' });
    const created = await service.create('HELD', body, 'expired-hold-fixture');
    const id = (created as { id: string }).id;
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id } })).status, 'HELD');
    assert.equal((await availability(property.id)).json().available, true);
    assert.equal((await request('GET', `/bookings/${id}`, a)).json().booking.effectiveStatus, 'EXPIRED');
    assert.deepEqual((await request('POST', `/bookings/${id}/extend`, a)).json(), { error: 'HOLD_EXPIRED' });
    assert.equal((await create(body)).statusCode, 201); // Same phone and dates, stale row still HELD.
    const currentService = new BookingService(db, context());
    await currentService.expireHold(id);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id } })).status, 'EXPIRED');
    const confirmedRoom = await room();
    const confirmed = await db.booking.create({ data: { tenantId: a.user.tenantId, propertyId: confirmedRoom.id,
      guestPhone: 'legacy', guestCount: 1, checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'), quoteTotalKobo: 20002, status: 'CONFIRMED' } });
    await assert.rejects(currentService.expireHold(confirmed.id), (e: unknown) => (e as { code: string }).code === 'INVALID_BOOKING_STATE');
    assert.equal((await request('POST', `/bookings/${confirmed.id}/cancel`, a, { reason: 'No verified refund workflow' })).statusCode, 409);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } })).status, 'CONFIRMED');
  });

  await t.test('all relevant occupying/review states reject new holds and existing blocks reject holds', async () => {
    for (const status of ['CONFIRMED', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING'] as const) {
      const property = await room();
      await db.booking.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, guestPhone: 'legacy', guestCount: 1,
        checkIn: new Date('2027-01-10T14:00:00+01:00'), checkOut: new Date('2027-01-12T11:00:00+01:00'), quoteTotalKobo: 20002, status } });
      assert.deepEqual((await create(input(property.id))).json(), { error: 'DATES_UNAVAILABLE' });
    }
    const property = await room();
    assert.equal((await request('POST', `/properties/${property.id}/blocks`, manager, { startDate: '2027-01-10', endDate: '2027-01-12', reason: 'Maintenance' })).statusCode, 201);
    assert.deepEqual((await create(input(property.id))).json(), { error: 'DATES_UNAVAILABLE' });
  });

  await t.test('validation and confirmation safeguards reject client state, money, tenant, payment and unsupported mutations', async () => {
    const property = await room();
    for (const patch of [{ tenantId: b.user.tenantId }, { status: 'CONFIRMED' }, { quoteTotalKobo: 1 }, { paymentReference: 'claimed-paid' },
      { checkIn: '2027-02-29' }, { checkOut: '2027-01-10' }, { checkOut: '2027-01-09' }, { guestCount: 1.1 }, { guestPhone: 'bad' }]) {
      const result = await create(input(property.id, patch));
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.equal((await request('POST', '/holds', a, input(property.id))).statusCode, 400);
    const created = await create(input(property.id));
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().booking.id;
    assert.equal((await request('PATCH', `/bookings/${id}`, a, { status: 'CONFIRMED' })).statusCode, 404);
    assert.equal((await request('POST', `/bookings/${id}/confirm`, a, { paid: true })).statusCode, 404);
    for (const actor of [a, manager, receptionist]) assert.equal((await request('GET', `/bookings/${id}`, actor)).json().booking.confirmed, false);
    assert.equal((await request('PATCH', `/properties/${property.id}`, receptionist, { baseNightlyPriceKobo: 1 })).statusCode, 403);
    assert.equal((await request('POST', `/properties/${property.id}/blocks`, receptionist, { startDate: '2027-02-01', endDate: '2027-02-02', reason: 'Forbidden' })).statusCode, 403);
  });

  await t.test('inactive properties, minimum stay and guest capacity reject creation without partial records', async () => {
    for (const [patch, expected] of [[{ isActive: false }, 'PROPERTY_INACTIVE'], [{ minimumStayNights: 3 }, 'MINIMUM_STAY_NOT_MET'], [{ maxGuests: 1 }, 'GUEST_CAPACITY_EXCEEDED']] as const) {
      const property = await room(a, patch);
      const result = await create(input(property.id));
      assert.equal(result.statusCode, 409);
      assert.equal(result.json().error, expected);
      assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 0);
    }
  });

  await t.test('every booking route requires authentication and tenant scoping in API and service', async () => {
    const property = await room();
    const created = await create(input(property.id));
    const id = created.json().booking.id;
    const routes: [HTTPMethods, string, object?][] = [
      ['POST', '/holds', input(property.id)], ['POST', '/bookings', input(property.id)], ['GET', '/bookings'],
      ['GET', `/bookings/${id}`], ['POST', `/bookings/${id}/extend`], ['POST', `/bookings/${id}/cancel`, { reason: 'Foreign' }]
    ];
    for (const [method, path, payload] of routes) assert.equal((await request(method, path, undefined, payload)).statusCode, 401);
    for (const actor of [b]) {
      assert.equal((await request('GET', `/bookings/${id}`, actor)).statusCode, 404);
      assert.equal((await request('POST', `/bookings/${id}/extend`, actor)).statusCode, 404);
      assert.equal((await request('POST', `/bookings/${id}/cancel`, actor, { reason: 'Foreign' })).statusCode, 404);
      assert.equal((await create(input(property.id), actor)).statusCode, 404);
      const listed = await request('GET', '/bookings', actor);
      const ownIds = new Set((await db.booking.findMany({ where: { tenantId: b.user.tenantId }, select: { id: true } })).map((row) => row.id));
      assert.equal(listed.json().bookings.length, ownIds.size);
      assert.ok(listed.json().bookings.every((row: { id: string }) => ownIds.has(row.id)));
      assert.equal((await request('GET', `/bookings?propertyId=${property.id}`, actor)).statusCode, 404);
      const foreignService = new BookingService(db, context(actor));
      await assert.rejects(foreignService.get(id), (e: unknown) => (e as { code: string }).code === 'NOT_FOUND');
      await assert.rejects(foreignService.cancel(id, { reason: 'Foreign' }), (e: unknown) => (e as { code: string }).code === 'NOT_FOUND');
    }
  });

  await t.test('malformed legacy HELD rows fail closed and produce an integrity alert without a successful mutation audit', async () => {
    const property = await room();
    // Simulate privileged corruption after migration. New normal writes cannot do this.
    const definition = await db.$queryRaw<{ definition: string }[]>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'Booking_values_check' AND connamespace = current_schema()::regnamespace`;
    await db.$executeRawUnsafe('ALTER TABLE "Booking" DROP CONSTRAINT "Booking_values_check"');
    let corruptId: string | undefined;
    try {
      const corrupt = await db.booking.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, guestPhone: '+2348067890123', guestCount: 1,
        checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'), quoteTotalKobo: 20002, status: 'HELD' } });
      corruptId = corrupt.id;
      const results = [await availability(property.id), await create(input(property.id)),
        await request('POST', `/properties/${property.id}/blocks`, manager, { startDate: '2027-01-10', endDate: '2027-01-12', reason: 'Unsafe' }),
        await request('GET', `/bookings/${corrupt.id}`, a)];
      for (const result of results) {
        assert.equal(result.statusCode, 409, result.body);
        assert.deepEqual(result.json(), { error: 'OCCUPANCY_REVIEW_REQUIRED' });
      }
      assert.equal(await db.auditLog.count({ where: { entityId: property.id, action: 'booking.integrity_review_required' } }), 4);
      assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 0);
      assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 1);
    } finally {
      if (corruptId) await db.booking.delete({ where: { id: corruptId } });
      await db.$executeRawUnsafe(`ALTER TABLE "Booking" ADD CONSTRAINT "Booking_values_check" ${definition[0]!.definition}`);
    }
  });

  await t.test('failed audit inserts roll back creation, idempotency, extension and cancellation', async () => {
    const property = await room();
    const invalid = new BookingService(db, { ...context(), user: { ...a.user, id: 'c' + 'z'.repeat(24) } });
    const failure = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003';
    await assert.rejects(invalid.create('HELD', input(property.id), 'rollback-create-key'), failure);
    assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 0);
    assert.equal(await db.bookingOperation.count({ where: { key: 'rollback-create-key' } }), 0);
    const created = await create(input(property.id));
    const booking = created.json().booking;
    await assert.rejects(invalid.extend(booking.id), failure);
    await assert.rejects(invalid.cancel(booking.id, { reason: 'Must roll back' }), failure);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(stored.status, 'HELD');
    assert.equal(stored.holdExtensionCount, 0);
    assert.equal(stored.holdExpiresAt!.toISOString(), booking.holdExpiresAt);
    assert.equal(stored.version, 0);
  });

  await t.test('actual database booking/phone guard rejections return safe conflicts and roll back all writes', async () => {
    const property = await room();
    // Insert a fixture after service checks but BEFORE the occupancy guard trigger.
    // This exercises PostgreSQL's real rejection and the HTTP error translation.
    await db.$executeRawUnsafe(`CREATE FUNCTION phase3_force_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."guestName" IN ('force-dates-guard', 'force-phone-guard') THEN
          INSERT INTO "Booking" (id, reference, "tenantId", "propertyId", "guestPhone", "guestCount", "checkIn", "checkOut", status, "holdExpiresAt", "quoteTotalKobo", "updatedAt")
          VALUES (NEW.id || '_fixture', NEW.reference || '_fixture', NEW."tenantId", NEW."propertyId",
            CASE WHEN NEW."guestName" = 'force-phone-guard' THEN NEW."guestPhone" ELSE '+2348000000000' END,
            1, NEW."checkIn", NEW."checkOut", 'HELD', (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour', 20002, (clock_timestamp() AT TIME ZONE 'UTC'));
        END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER a_phase3_force_guard BEFORE INSERT ON "Booking" FOR EACH ROW EXECUTE FUNCTION phase3_force_guard()');
    try {
      const before = await db.auditLog.count();
      for (const [guestName, expected] of [['force-dates-guard', 'DATES_UNAVAILABLE'], ['force-phone-guard', 'GUEST_ACTIVE_HOLD']] as const) {
        const result = await create(input(property.id, { guestName }));
        assert.equal(result.statusCode, 409, result.body);
        assert.deepEqual(result.json(), { error: expected });
        assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 0);
      }
      assert.equal(await db.auditLog.count(), before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER a_phase3_force_guard ON "Booking"');
      await db.$executeRawUnsafe('DROP FUNCTION phase3_force_guard()');
    }
  });
});
