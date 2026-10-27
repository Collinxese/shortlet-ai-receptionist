import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { isolatedDatabase } from './database.js';
import { Prisma } from '@prisma/client';
import { TenantRepository } from '../../src/services/tenant-repository.js';
import { lagosMidnight } from '../../src/services/calendar.js';

test('Phase 2 security audit regressions', async (t) => {
  let app: FastifyInstance | undefined;
  t.after(async () => { await app?.close(); });
  const { db, databaseUrl, deploy } = await isolatedDatabase(t);
  deploy();
  app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }), { db, logger: false });
  const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    tenantName: 'Audit tenant', name: 'Audit owner', email: 'audit@example.com', password: 'audit-test-only-password'
  } });
  assert.equal(registered.statusCode, 201);
  const { accessToken, user } = registered.json();
  const request = (method: HTTPMethods, path: string, payload?: object) => app!.inject({
    method, url: `/api${path}`, headers: { authorization: `Bearer ${accessToken}` }, payload
  });
  const room = (name = 'Audit property') => db.property.create({ data: {
    tenantId: user.tenantId, name, area: 'Lagos', bedrooms: 1, bathrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001
  } });

  await t.test('legacy property text outside new creation limits must not prevent deactivation', async () => {
    const legacyName = 'L'.repeat(121); // Valid in both prior schema and the Phase 2 migration.
    const property = await room(legacyName);
    const legacyDescription = 'D'.repeat(5001);
    await db.property.update({ where: { id: property.id }, data: { description: legacyDescription } });
    const priceChange = await request('PATCH', `/properties/${property.id}`, { baseNightlyPriceKobo: 10003 });
    assert.equal(priceChange.statusCode, 200, priceChange.body);
    assert.equal(priceChange.json().property.description, legacyDescription);
    const response = await request('DELETE', `/properties/${property.id}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().property.isActive, false);
    assert.equal(response.json().property.name, legacyName);
    assert.equal(response.json().property.description, legacyDescription);
    const event = await db.auditLog.findFirstOrThrow({ where: { tenantId: user.tenantId, entityId: property.id, action: 'property.deactivated' } });
    assert.deepEqual(event.before, { isActive: true });
    assert.deepEqual(event.after, { isActive: false });
    assert.equal(event.actorId, user.id);
  });

  await t.test('an operator block must not overlap an existing confirmed booking', async () => {
    const property = await room();
    await db.booking.create({ data: {
      tenantId: user.tenantId, propertyId: property.id, guestPhone: 'private-test-fixture', guestCount: 1,
      checkIn: new Date('2026-11-10T14:00:00+01:00'), checkOut: new Date('2026-11-12T11:00:00+01:00'),
      quoteTotalKobo: 20002, status: 'CONFIRMED'
    } });
    const response = await request('POST', `/properties/${property.id}/blocks`, {
      startDate: '2026-11-10', endDate: '2026-11-12', reason: 'Maintenance'
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { error: 'BOOKING_OVERLAP' });
    assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 0);
    assert.equal(await db.auditLog.count({ where: { tenantId: user.tenantId, action: 'availability.block.created' } }), 0);
  });

  await t.test('stored bookings may span beyond API date bounds without rejecting a valid availability query', async () => {
    const property = await room();
    for (const [checkIn, checkOut] of [
      ['1999-12-31T14:00:00+01:00', '2000-01-03T11:00:00+01:00'],
      ['2199-12-29T14:00:00+01:00', '2200-01-02T11:00:00+01:00']
    ]) await db.booking.create({ data: {
      tenantId: user.tenantId, propertyId: property.id, guestPhone: 'private-test-fixture', guestCount: 1,
      checkIn: new Date(checkIn!), checkOut: new Date(checkOut!), quoteTotalKobo: 20002, status: 'CONFIRMED'
    } });
    const responses = await Promise.all([
      request('GET', `/properties/${property.id}/availability?checkIn=2000-01-01&checkOut=2000-01-02`),
      request('GET', `/properties/${property.id}/availability?checkIn=2199-12-30&checkOut=2199-12-31`)
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    for (const response of responses) assert.equal(response.json().available, false);
  });

  await t.test('blocks and availability use one occupancy policy for every existing booking state and hold expiry', async () => {
    const property = await room();
    const booking = await db.booking.create({ data: {
      tenantId: user.tenantId, propertyId: property.id, guestPhone: 'private-test-fixture', guestCount: 1,
      checkIn: new Date('2026-11-10T14:00:00+01:00'), checkOut: new Date('2026-11-12T11:00:00+01:00'),
      quoteTotalKobo: 20002, status: 'REQUESTED'
    } });
    const body = { startDate: '2026-11-10', endDate: '2026-11-12', reason: 'Occupancy regression' };
    const cases = [
      ['CONFIRMED', null, true], ['PAYMENT_REVIEW', null, true], ['VERIFICATION_PENDING', null, true],
      ['HELD', new Date(Date.now() + 3_600_000), true], ['HELD', new Date(Date.now() - 1), false],
      ['REQUESTED', null, false], ['EXPIRED', null, false], ['CANCELLED', null, false], ['PAID_CONFLICT', null, false],
      ['REFUND_PENDING', null, false], ['REFUNDED', null, false], ['REFUND_DUE', null, false]
    ] as const;
    for (const [status, holdExpiresAt, occupying] of cases) {
      await db.booking.update({ where: { id: booking.id }, data: { status, holdExpiresAt } });
      const calendar = await request('GET', `/properties/${property.id}/availability?checkIn=2026-11-10&checkOut=2026-11-12`);
      assert.equal(calendar.statusCode, 200, calendar.body);
      assert.equal(calendar.json().available, !occupying, status);
      const before = await db.auditLog.count({ where: { tenantId: user.tenantId } });
      const response = await request('POST', `/properties/${property.id}/blocks`, body);
      assert.equal(response.statusCode, occupying ? 409 : 201, `${status}: ${response.body}`);
      if (occupying) {
        assert.deepEqual(response.json(), { error: 'BOOKING_OVERLAP' });
        assert.equal(await db.auditLog.count({ where: { tenantId: user.tenantId } }), before);
      } else {
        assert.equal((await request('DELETE', `/properties/${property.id}/blocks/${response.json().block.id}`)).statusCode, 204);
      }
      assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, status);
    }
    // Phase 3 replaces the old permissive malformed-hold assertion with a DB guard.
    await assert.rejects(db.booking.update({ where: { id: booking.id }, data: { status: 'HELD', holdExpiresAt: null } }));
    await db.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
    for (const [startDate, endDate] of [['2026-11-08', '2026-11-10'], ['2026-11-12', '2026-11-14']] as const) {
      const adjacent = await request('POST', `/properties/${property.id}/blocks`, { startDate, endDate, reason: 'Adjacent boundary' });
      assert.equal(adjacent.statusCode, 201, adjacent.body);
    }
  });

  await t.test('Phase 3 guards reject booking/hold conflicts and raw cross-table writes', async () => {
    const property = await room();
    const data = { tenantId: user.tenantId, propertyId: property.id, guestPhone: 'test-only', guestCount: 1,
      checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'), quoteTotalKobo: 20002 };
    await db.booking.create({ data: { ...data, status: 'CONFIRMED' } });
    await assert.rejects(db.booking.create({ data: { ...data, status: 'HELD', holdExpiresAt: new Date(Date.now() + 3_600_000) } }));
    await assert.rejects(db.availabilityBlock.create({ data: { tenantId: user.tenantId, propertyId: property.id,
      startDate: data.checkIn, endDate: data.checkOut, reason: 'Raw writer must also use database guard' } }));
    assert.equal(await db.booking.count({ where: { propertyId: property.id } }), 1);
    assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 0);
    const constraints = await db.$queryRaw<{ name: string; tableName: string; definition: string }[]>`
      SELECT conname AS name, conrelid::regclass::text AS "tableName", pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE contype = 'x' AND connamespace = current_schema()::regnamespace`;
    assert.deepEqual(constraints.map((item) => item.name).sort(), ['AvailabilityBlock_no_overlap', 'Booking_durable_no_overlap', 'PriceRule_dates_no_overlap']);
    assert.ok(constraints.every((item) => item.definition.includes('[)') && item.definition.includes('"tenantId"') && item.definition.includes('"propertyId"')));
    const calendar = await request('GET', `/properties/${property.id}/availability?checkIn=2027-01-10&checkOut=2027-01-12`);
    assert.equal(calendar.json().available, false);
  });

  await t.test('consecutive bookings exclude checkout and reads reserve nothing or expose guest data', async () => {
    const property = await room();
    for (const [checkIn, checkOut] of [['2027-02-10', '2027-02-12'], ['2027-02-12', '2027-02-14']] as const) {
      await db.booking.create({ data: { tenantId: user.tenantId, propertyId: property.id, guestPhone: 'private-fixture', guestCount: 1,
        checkIn: lagosMidnight(checkIn), checkOut: lagosMidnight(checkOut), quoteTotalKobo: 20002, status: 'CONFIRMED' } });
    }
    const counts = [await db.booking.count(), await db.availabilityBlock.count(), await db.auditLog.count()];
    for (const [checkIn, checkOut, expected] of [
      ['2027-02-08', '2027-02-10', true], ['2027-02-10', '2027-02-12', false],
      ['2027-02-12', '2027-02-14', false], ['2027-02-14', '2027-02-16', true]
    ] as const) {
      const result = await request('GET', `/properties/${property.id}/availability?checkIn=${checkIn}&checkOut=${checkOut}`);
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().available, expected);
      assert.equal(result.body.includes('private-fixture'), false);
      assert.equal('bookingId' in result.json(), false);
      assert.equal('reservationId' in result.json(), false);
    }
    assert.deepEqual([await db.booking.count(), await db.availabilityBlock.count(), await db.auditLog.count()], counts);
  });

  await t.test('audit failures roll back property/fee updates, block creation and child deletion', async () => {
    const property = await room();
    const fee = await db.propertyFee.create({ data: { tenantId: user.tenantId, propertyId: property.id, label: 'Original fee', amountKobo: 10001 } });
    const repo = new TenantRepository(db, { user: { ...user, id: 'c' + 'z'.repeat(24) }, sessionId: 'test-only' });
    const failActor = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
    const auditCount = await db.auditLog.count();
    await assert.rejects(repo.updateProperty(property.id, { name: 'Must roll back', otherFees: [{ label: 'Replacement', amountKobo: 10003 }] }), failActor);
    assert.equal((await db.property.findUniqueOrThrow({ where: { id: property.id } })).name, property.name);
    assert.equal((await db.propertyFee.findFirstOrThrow({ where: { propertyId: property.id } })).id, fee.id);
    await assert.rejects(repo.createBlock(property.id, { startDate: '2027-03-01', endDate: '2027-03-03', reason: 'Must roll back' }), failActor);
    assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 0);
    const block = await db.availabilityBlock.create({ data: { tenantId: user.tenantId, propertyId: property.id, reason: 'Keep block',
      startDate: lagosMidnight('2027-03-01'), endDate: lagosMidnight('2027-03-03') } });
    await assert.rejects(repo.removeBlock(property.id, block.id), failActor);
    assert.ok(await db.availabilityBlock.findUnique({ where: { id: block.id } }));
    const override = await db.priceRule.create({ data: { tenantId: user.tenantId, propertyId: property.id, label: 'Keep override', nightlyPriceKobo: 10003,
      startDate: lagosMidnight('2027-03-01'), endDate: lagosMidnight('2027-03-03') } });
    await assert.rejects(repo.removePriceOverride(property.id, override.id), failActor);
    assert.ok(await db.priceRule.findUnique({ where: { id: override.id } }));
    assert.equal(await db.auditLog.count(), auditCount);
  });

  await t.test('actual PostgreSQL exclusion violations return safe conflict errors and roll back rows and audit events', async () => {
    const property = await room();
    // A schema-local test trigger inserts a conflicting row after the service's
    // precheck, forcing the real exclusion constraint without timing-based tests.
    await db.$executeRawUnsafe(`CREATE FUNCTION audit_conflicting_block() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reason = 'audit-forced-exclusion' THEN
          INSERT INTO "AvailabilityBlock" (id, "tenantId", "propertyId", "startDate", "endDate", reason)
          VALUES (NEW.id || '_fixture', NEW."tenantId", NEW."propertyId", NEW."startDate", NEW."endDate", 'Trigger fixture');
        END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER audit_conflicting_block BEFORE INSERT ON "AvailabilityBlock"
      FOR EACH ROW EXECUTE FUNCTION audit_conflicting_block()`);
    await db.$executeRawUnsafe(`CREATE FUNCTION audit_conflicting_price() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.label = 'audit-forced-exclusion' THEN
          INSERT INTO "PriceRule" (id, "tenantId", "propertyId", "startDate", "endDate", label, "nightlyPriceKobo")
          VALUES (NEW.id || '_fixture', NEW."tenantId", NEW."propertyId", NEW."startDate", NEW."endDate", 'Trigger fixture', NEW."nightlyPriceKobo");
        END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER audit_conflicting_price BEFORE INSERT ON "PriceRule"
      FOR EACH ROW EXECUTE FUNCTION audit_conflicting_price()`);
    try {
      const before = await db.auditLog.count();
      const block = await request('POST', `/properties/${property.id}/blocks`, {
        startDate: '2027-04-01', endDate: '2027-04-03', reason: 'audit-forced-exclusion'
      });
      assert.equal(block.statusCode, 409, block.body);
      assert.deepEqual(block.json(), { error: 'BLOCK_OVERLAP' });
      const price = await request('POST', `/properties/${property.id}/price-overrides`, {
        startDate: '2027-04-01', endDate: '2027-04-03', label: 'audit-forced-exclusion', nightlyPriceKobo: 10003
      });
      assert.equal(price.statusCode, 409, price.body);
      assert.deepEqual(price.json(), { error: 'PRICE_OVERRIDE_OVERLAP' });
      assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 0);
      assert.equal(await db.priceRule.count({ where: { propertyId: property.id } }), 0);
      assert.equal(await db.auditLog.count(), before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER audit_conflicting_block ON "AvailabilityBlock"');
      await db.$executeRawUnsafe('DROP FUNCTION audit_conflicting_block()');
      await db.$executeRawUnsafe('DROP TRIGGER audit_conflicting_price ON "PriceRule"');
      await db.$executeRawUnsafe('DROP FUNCTION audit_conflicting_price()');
    }
  });
});
