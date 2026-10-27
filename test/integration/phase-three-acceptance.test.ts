import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { BookingService } from '../../src/services/booking-service.js';
import type { PublicUser } from '../../src/services/authentication.js';
import { guestPhone, normalizeGuestPhone } from '../../src/services/booking-validation.js';
import { lagosMidnight } from '../../src/services/calendar.js';
import { isolatedDatabase } from './database.js';

type Account = { accessToken: string; user: PublicUser };
test('Phase 3 acceptance audit regressions and security boundaries', async (t) => {
  let app: FastifyInstance | undefined;
  t.after(async () => { await app?.close(); });
  const { db, schema, databaseUrl, deploy } = await isolatedDatabase(t);
  deploy();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_RATE_LIMIT_MAX: '30' }), { db, logger: false });
  let sequence = 0;
  const request = (method: HTTPMethods, path: string, account?: Account, payload?: object, key?: string) => app!.inject({
    method, url: `/api${path}`, remoteAddress: `198.18.${Math.floor(sequence / 200) % 250}.${++sequence % 200 + 1}`,
    headers: { ...(account ? { authorization: `Bearer ${account.accessToken}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, payload
  });
  const password = 'acceptance-test-only-password';
  const register = async (label: string): Promise<Account> => {
    const response = await request('POST', '/auth/register', undefined, { tenantName: label, name: label, email: `${label}@example.com`, password });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const owner = await register('acceptance-owner'), other = await register('acceptance-other');
  const actors = [owner];
  for (const role of ['MANAGER', 'RECEPTIONIST'] as const) {
    const email = `acceptance-${role.toLowerCase()}@example.com`;
    assert.equal((await request('POST', '/team', owner, { name: role, email, password, role })).statusCode, 201);
    const login = await request('POST', '/auth/login', undefined, { email, password });
    assert.equal(login.statusCode, 200);
    actors.push(login.json());
  }
  const room = (account = owner) => db.property.create({ data: { tenantId: account.user.tenantId,
    name: 'Acceptance room', area: 'Lagos', bedrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001 } });
  const stay = { checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12') };
  const body = (propertyId: string, phone = `+23480${String(++sequence).padStart(8, '0')}`) => ({
    propertyId, checkIn: '2027-01-10', checkOut: '2027-01-12', guestName: 'Acceptance guest', guestPhone: phone, guestCount: 1
  });
  const legacyHold = (propertyId: string, phone: string, holdExpiresAt = new Date(Date.now() + 3600000)) => db.booking.create({ data: {
    tenantId: owner.user.tenantId, propertyId, guestPhone: phone, guestCount: 1, ...stay,
    status: 'HELD', holdExpiresAt, quoteTotalKobo: 20002
  } });

  await t.test('SQL and lock normalization match API trimming, including every ECMAScript boundary whitespace', async () => {
    const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    for (const character of whitespace) {
      const padded = `${character}0801 234-5678${character}`;
      const expected = guestPhone.parse(padded);
      const rows = await db.$queryRaw<{ phone: string }[]>`SELECT booking_phone(${padded}) AS phone`;
      assert.equal(rows[0]!.phone, expected, `SQL U+${character.codePointAt(0)!.toString(16)}`);
      assert.equal(normalizeGuestPhone(padded), expected, `lock U+${character.codePointAt(0)!.toString(16)}`);
    }
  });

  await t.test('legacy surrounding whitespace cannot bypass tenant-wide guest holds through the API or raw SQL', async () => {
    const [source, target] = await Promise.all([room(), room()]);
    await legacyHold(source.id, '\t08022345678\n');
    const result = await request('POST', '/holds', owner, body(target.id, '+2348022345678'), 'acceptance-normalized-phone');
    assert.equal(result.statusCode, 409, result.body);
    assert.deepEqual(result.json(), { error: 'GUEST_ACTIVE_HOLD' });
    await assert.rejects(legacyHold(target.id, '+2348022345678'), /Booking_guest_active_hold/);
    assert.equal(await db.booking.count({ where: { propertyId: target.id } }), 0);
    assert.equal(await db.bookingOperation.count({ where: { key: 'acceptance-normalized-phone' } }), 0);
  });

  await t.test('malformed guest hold alerts identify the property containing the bad row, not a different requested property', async () => {
    const [source, target] = await Promise.all([room(), room()]);
    const definitions = await db.$queryRaw<{ definition: string }[]>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'Booking_values_check' AND connamespace = current_schema()::regnamespace`;
    // Corruption simulation only, inside this generated disposable schema.
    await db.$executeRawUnsafe('ALTER TABLE "Booking" DROP CONSTRAINT "Booking_values_check"');
    let corruptId: string | undefined;
    try {
      const corrupt = await db.booking.create({ data: { tenantId: owner.user.tenantId, propertyId: source.id,
        guestPhone: '+2348032345678', guestCount: 1, ...stay, status: 'HELD', quoteTotalKobo: 20002 } });
      corruptId = corrupt.id;
      const result = await request('POST', '/holds', owner, body(target.id, '+2348032345678'), 'acceptance-malformed-source');
      assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(result.json(), { error: 'OCCUPANCY_REVIEW_REQUIRED' });
      const event = await db.auditLog.findFirstOrThrow({ where: { tenantId: owner.user.tenantId, action: 'booking.integrity_review_required' } });
      assert.equal(event.entityType, 'Property');
      assert.equal(event.entityId, source.id);
      assert.equal(event.actorId, owner.user.id);
      assert.equal(await db.booking.count({ where: { propertyId: target.id } }), 0);
      assert.equal(await db.bookingOperation.count({ where: { key: 'acceptance-malformed-source' } }), 0);
    } finally {
      if (corruptId) await db.booking.delete({ where: { id: corruptId } });
      await db.$executeRawUnsafe(`ALTER TABLE "Booking" ADD CONSTRAINT "Booking_values_check" ${definitions[0]!.definition}`);
    }
  });

  await t.test('qualified SQL cannot redirect booking/block guards to caller-schema or temporary decoy tables', async () => {
    assert.match(schema, /^phase2_test_[a-f0-9]+$/);
    const callerSchema = `${schema}_caller`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${callerSchema}"`);
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "${callerSchema}"."Property" (id text, "tenantId" text, "isActive" boolean)`);
      for (const mode of ['caller-schema', 'temporary-table'] as const) {
        const blocked = await room(), held = await room();
        await db.availabilityBlock.create({ data: { tenantId: owner.user.tenantId, propertyId: blocked.id,
          startDate: stay.checkIn, endDate: stay.checkOut, reason: 'Existing block' } });
        await legacyHold(held.id, mode === 'caller-schema' ? '+2348042345678' : '+2348052345678');
        const prepare = async (tx: Prisma.TransactionClient) => {
          if (mode === 'temporary-table') {
            await tx.$executeRawUnsafe('CREATE TEMP TABLE "Property" (id text, "tenantId" text, "isActive" boolean) ON COMMIT DROP');
          }
          await tx.$executeRawUnsafe(`SET LOCAL search_path = pg_catalog, "${callerSchema}", "${schema}"`);
        };
        await assert.rejects(db.$transaction(async (tx) => {
          await prepare(tx);
          await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."Booking"
            (id, reference, "tenantId", "propertyId", "guestPhone", "guestCount", "checkIn", "checkOut", status, "holdExpiresAt", "quoteTotalKobo", "updatedAt")
            VALUES ($1,$2,$3,$4,'+2348062345678',1,$5,$6,'HELD',(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour',20002,(clock_timestamp() AT TIME ZONE 'UTC'))`,
          `qualified-${mode}`, `reference-${mode}`, owner.user.tenantId, blocked.id, stay.checkIn, stay.checkOut);
        }), /Booking_block_conflict/, mode);
        await assert.rejects(db.$transaction(async (tx) => {
          await prepare(tx);
          await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."AvailabilityBlock" (id,"tenantId","propertyId","startDate","endDate",reason)
            VALUES ($1,$2,$3,$4,$5,'Qualified write over hold')`, `qualified-block-${mode}`, owner.user.tenantId, held.id, stay.checkIn, stay.checkOut);
        }), /Block_booking_conflict/, mode);
        assert.equal(await db.booking.count({ where: { propertyId: blocked.id } }), 0);
        assert.equal(await db.availabilityBlock.count({ where: { propertyId: held.id } }), 0);
      }
    } finally { await db.$executeRawUnsafe(`DROP SCHEMA "${callerSchema}" CASCADE`); }
  });

  await t.test('all roles can use every routine booking endpoint and cannot enumerate another tenant', async () => {
    const foreignProperty = await room(other);
    const foreign = await request('POST', '/holds', other, body(foreignProperty.id), 'acceptance-foreign-booking');
    assert.equal(foreign.statusCode, 201, foreign.body);
    const foreignId: string = foreign.json().booking.id;
    for (const actor of actors) {
      const property = await room();
      const created = await request('POST', '/holds', actor, body(property.id), `acceptance-role-hold-${actor.user.role}`);
      assert.equal(created.statusCode, 201, created.body);
      const id: string = created.json().booking.id;
      assert.equal(created.json().booking.confirmed, false);
      assert.equal((await request('GET', `/bookings/${id}`, actor)).statusCode, 200);
      assert.equal((await request('GET', `/bookings?propertyId=${property.id}`, actor)).json().bookings[0].id, id);
      assert.equal((await request('POST', `/bookings/${id}/extend`, actor)).statusCode, 200);
      assert.equal((await request('POST', `/bookings/${id}/cancel`, actor, { reason: 'Acceptance cancellation' })).statusCode, 200);
      const requested = await request('POST', '/bookings', actor, body(property.id), `acceptance-role-request-${actor.user.role}`);
      assert.equal(requested.statusCode, 201, requested.body);
      assert.equal(requested.json().booking.confirmed, false);
      for (const candidate of [foreignId, 'c' + 'z'.repeat(24)]) {
        assert.deepEqual((await request('GET', `/bookings/${candidate}`, actor)).json(), { error: 'NOT_FOUND' });
        assert.equal((await request('POST', `/bookings/${candidate}/extend`, actor)).statusCode, 404);
        assert.equal((await request('POST', `/bookings/${candidate}/cancel`, actor, { reason: 'No access' })).statusCode, 404);
      }
      assert.equal((await request('GET', `/bookings?propertyId=${foreignProperty.id}`, actor)).statusCode, 404);
      for (const path of ['/holds', '/bookings']) assert.equal((await request('POST', path, actor, body(foreignProperty.id), `foreign-${path.slice(1)}-${actor.user.role}`)).statusCode, 404);
      const service = new BookingService(db, { user: actor.user, sessionId: 'test-only' });
      await assert.rejects(service.create('CONFIRMED' as 'HELD', body(property.id), 'invalid-internal-state'), (e: unknown) =>
        (e as { code: string }).code === 'TRANSITION_UNAVAILABLE');
    }
  });

  await t.test('no role can cancel or expire confirmed occupancy, or invoke financial transitions through the API', async () => {
    const property = await room();
    const booking = await db.booking.create({ data: { tenantId: owner.user.tenantId, propertyId: property.id,
      guestName: 'Private confirmed fixture', guestPhone: '+2348072345678', guestCount: 1, ...stay, quoteTotalKobo: 20002, status: 'CONFIRMED' } });
    const beforeAudit = await db.auditLog.count();
    for (const actor of actors) {
      const result = await request('POST', `/bookings/${booking.id}/cancel`, actor, { reason: 'Must remain occupied' });
      assert.equal(result.statusCode, 409, result.body);
      assert.deepEqual(result.json(), { error: 'INVALID_BOOKING_STATE' });
      const service = new BookingService(db, { user: actor.user, sessionId: 'test-only' });
      await assert.rejects(service.expireHold(booking.id), (e: unknown) => (e as { code: string }).code === 'INVALID_BOOKING_STATE');
      for (const status of ['CONFIRMED', 'PAYMENT_REVIEW', 'PAID_CONFLICT', 'REFUND_PENDING', 'REFUNDED', 'VERIFICATION_PENDING', 'REFUND_DUE']) {
        assert.equal((await request('POST', '/bookings', actor, { ...body(property.id), status }, `forged-state-${actor.user.role}-${status}`)).statusCode, 400);
      }
    }
    assert.deepEqual(await db.booking.findUniqueOrThrow({ where: { id: booking.id } }), booking);
    assert.equal(await db.auditLog.count(), beforeAudit);
    const calendar = await request('GET', `/properties/${property.id}/availability?checkIn=2027-01-10&checkOut=2027-01-12`, owner);
    assert.equal(calendar.statusCode, 200);
    assert.equal(calendar.json().available, false);
    assert.equal(calendar.body.includes('Private confirmed fixture'), false);
    assert.equal(calendar.body.includes('+2348072345678'), false);
  });
});
