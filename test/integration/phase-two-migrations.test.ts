import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedDatabase } from './database.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { execFileSync } from 'node:child_process';

async function phaseOneDatabase(t: TestContext) {
  const context = await isolatedDatabase(t);
  context.executeMigration('20261024000100_initial');
  context.executeMigration('20261024000200_auth_tenant_isolation');
  await context.db.$executeRaw`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('tenant-a', 'Fixture tenant', NOW())`;
  await context.db.$executeRaw`INSERT INTO "Property" (id, "tenantId", name, area, bedrooms, "maxGuests", "baseNightlyPriceKobo", "earlyCheckInFeeKobo", "updatedAt")
    VALUES ('property-a', 'tenant-a', 'Legacy property', 'Lagos', 2, 4, 5000000, 200000, NOW())`;
  return { ...context, upgrade: () => context.executeMigration('20261024000300_properties_availability') };
}

test('Phase 2 migration preserves populated Phase 1 data and readiness detects an incomplete upgrade', async (t) => {
  const { db, databaseUrl, upgrade } = await phaseOneDatabase(t);
  const legacyName = 'L'.repeat(121);
  const legacyDescription = 'D'.repeat(5001);
  await db.$executeRaw`UPDATE "Property" SET name = ${legacyName}, description = ${legacyDescription} WHERE id = 'property-a'`;
  await db.$executeRaw`INSERT INTO "AvailabilityBlock" (id, "tenantId", "propertyId", "startDate", "endDate", reason)
    VALUES ('legacy-block', 'tenant-a', 'property-a', '2026-11-09 23:00:00', '2026-11-11 23:00:00', 'Preserve me')`;
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl }), { logger: false });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    assert.equal((await app.inject('/api/ready')).statusCode, 503);
    upgrade();
    assert.equal((await app.inject('/api/ready')).statusCode, 503);
    // Phase 3 readiness also requires booking snapshots and idempotency storage.
    const cli = (...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
    });
    cli('db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/migrations/20261025000100_booking_engine/migration.sql');
    assert.equal((await app.inject('/api/ready')).statusCode, 503);
    cli('db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/migrations/20261025000200_booking_acceptance_guards/migration.sql');
    cli('db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/migrations/20261025000300_payment_foundation/migration.sql');
    assert.equal((await app.inject('/api/ready')).statusCode, 503);
    cli('db', 'execute', '--schema', 'prisma/schema.prisma', '--file', 'prisma/migrations/20261026000100_conversation_engine/migration.sql');
    assert.equal((await app.inject('/api/ready')).statusCode, 200);
  } finally { await app.close(); }
  const property = await db.property.findUniqueOrThrow({ where: { id: 'property-a' }, include: { otherFees: true } });
  assert.equal(property.baseNightlyPriceKobo, 5000000n);
  assert.equal(property.name, legacyName);
  assert.equal(property.description, legacyDescription);
  assert.equal(property.weekendNightlyPriceKobo, null);
  assert.equal(property.cleaningFeeKobo, 0n);
  assert.equal(property.bathrooms, 0);
  assert.deepEqual(property.amenities, []);
  assert.deepEqual(property.otherFees, []);
  assert.equal(property.earlyCheckInFeeKobo, 200000n);
  assert.equal(property.earlyCheckInAllowed, true);
  assert.equal((await db.availabilityBlock.findUniqueOrThrow({ where: { id: 'legacy-block' } })).reason, 'Preserve me');
});

test('Phase 2 migration rejects invalid legacy prices atomically without deleting data', async (t) => {
  const { db, upgrade } = await phaseOneDatabase(t);
  await db.$executeRaw`UPDATE "Property" SET "baseNightlyPriceKobo" = -1 WHERE id = 'property-a'`;
  assert.throws(upgrade, /Property_money_check/);
  const rows = await db.$queryRaw<{ baseNightlyPriceKobo: bigint }[]>`SELECT "baseNightlyPriceKobo" FROM "Property" WHERE id = 'property-a'`;
  assert.equal(rows[0]?.baseNightlyPriceKobo, -1n);
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Property' AND column_name = 'bathrooms'`;
  assert.equal(columns[0]?.count, 0n);
});

test('Phase 2 migration rejects overlapping legacy blocks atomically for manual resolution', async (t) => {
  const { db, upgrade } = await phaseOneDatabase(t);
  await db.$executeRaw`INSERT INTO "AvailabilityBlock" (id, "tenantId", "propertyId", "startDate", "endDate", reason)
    VALUES ('overlap-a', 'tenant-a', 'property-a', '2026-11-09 23:00:00', '2026-11-11 23:00:00', 'Preserve A'),
      ('overlap-b', 'tenant-a', 'property-a', '2026-11-10 23:00:00', '2026-11-12 23:00:00', 'Preserve B')`;
  assert.throws(upgrade, /AvailabilityBlock_no_overlap/);
  assert.equal(await db.availabilityBlock.count(), 2);
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Property' AND column_name = 'bathrooms'`;
  assert.equal(columns[0]?.count, 0n);
});

test('Phase 2 migration rejects empty legacy block ranges without leaving schema changes', async (t) => {
  const { db, upgrade } = await phaseOneDatabase(t);
  await db.$executeRaw`INSERT INTO "AvailabilityBlock" (id, "tenantId", "propertyId", "startDate", "endDate", reason)
    VALUES ('empty-block', 'tenant-a', 'property-a', '2026-11-09 23:00:00', '2026-11-09 23:00:00', 'Preserve fixture')`;
  assert.throws(upgrade, /AvailabilityBlock_dates_check/);
  const rows = await db.$queryRaw<{ reason: string }[]>`SELECT reason FROM "AvailabilityBlock" WHERE id = 'empty-block'`;
  assert.equal(rows[0]?.reason, 'Preserve fixture');
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Property' AND column_name = 'bathrooms'`;
  assert.equal(columns[0]?.count, 0n);
});

test('Phase 2 migration rejects overlapping finite date-only overrides without altering legacy prices', async (t) => {
  const { db, upgrade } = await phaseOneDatabase(t);
  await db.$executeRaw`INSERT INTO "PriceRule" (id, "tenantId", "propertyId", "startDate", "endDate", label, "nightlyPriceKobo")
    VALUES ('override-a', 'tenant-a', 'property-a', '2026-11-09 23:00:00', '2026-11-11 23:00:00', 'Preserve A', 10001),
      ('override-b', 'tenant-a', 'property-a', '2026-11-10 23:00:00', '2026-11-12 23:00:00', 'Preserve B', 10003)`;
  assert.throws(upgrade, /PriceRule_dates_no_overlap/);
  const prices = await db.priceRule.findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(prices.map((price) => price.nightlyPriceKobo), [10001n, 10003n]);
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Property' AND column_name = 'bathrooms'`;
  assert.equal(columns[0]?.count, 0n);
});

test('failed migrate deploy preserves data and can recover through the documented rolled-back resolution', async (t) => {
  const { db, databaseUrl, deploy } = await phaseOneDatabase(t);
  const cli = (...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
  });
  // Baseline only this generated fixture schema, whose first two migrations were executed above.
  cli('migrate', 'resolve', '--applied', '20261024000100_initial');
  cli('migrate', 'resolve', '--applied', '20261024000200_auth_tenant_isolation');
  await db.$executeRaw`UPDATE "Property" SET "baseNightlyPriceKobo" = -1 WHERE id = 'property-a'`;
  // Prisma may mask the originating CHECK error while trying to record an error
  // inside the aborted transaction. Verify actual data/history and rollback below.
  assert.throws(deploy, /Property_money_check|current transaction is aborted/);
  const unchanged = await db.$queryRaw<{ baseNightlyPriceKobo: bigint }[]>`SELECT "baseNightlyPriceKobo" FROM "Property" WHERE id = 'property-a'`;
  assert.equal(unchanged[0]?.baseNightlyPriceKobo, -1n);
  const failed = await db.$queryRaw<{ finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = '20261024000300_properties_availability'`;
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.finished_at, null);
  assert.equal(failed[0]?.rolled_back_at, null);
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Property' AND column_name = 'bathrooms'`;
  assert.equal(columns[0]?.count, 0n);
  // Repair test fixture data only, then follow the README's recovery commands.
  await db.$executeRaw`UPDATE "Property" SET "baseNightlyPriceKobo" = 20001 WHERE id = 'property-a'`;
  cli('migrate', 'resolve', '--rolled-back', '20261024000300_properties_availability');
  assert.match(deploy(), /All migrations have been successfully applied/);
  const property = await db.property.findUniqueOrThrow({ where: { id: 'property-a' } });
  assert.equal(property.baseNightlyPriceKobo, 20001n);
  assert.equal(await db.property.count(), 1);
  assert.equal(await db.tenant.count(), 1);
});
