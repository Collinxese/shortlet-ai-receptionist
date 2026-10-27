import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isolatedDatabase } from './database.js';

const prior = ['20261024000100_initial', '20261024000200_auth_tenant_isolation', '20261024000300_properties_availability'];
const migration = '20261025000100_booking_engine';
async function legacy(t: TestContext) {
  const context = await isolatedDatabase(t);
  for (const name of prior) context.executeMigration(name);
  await context.db.$executeRaw`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('tenant-a', 'Legacy', NOW())`;
  await context.db.$executeRaw`INSERT INTO "Property" (id, "tenantId", name, area, bedrooms, "maxGuests", "baseNightlyPriceKobo", "updatedAt")
    VALUES ('property-a', 'tenant-a', 'Legacy', 'Lagos', 1, 2, 10001, NOW()), ('property-b', 'tenant-a', 'Other', 'Lagos', 1, 2, 10001, NOW())`;
  const insert = (id: string, propertyId = 'property-a', phone = '+2348012345678', state = 'CONFIRMED', expiry: Date | null = null) => context.db.$executeRaw`
    INSERT INTO "Booking" (id, "tenantId", "propertyId", "guestPhone", "guestCount", "checkIn", "checkOut", status, "holdExpiresAt", "quoteTotalKobo", "updatedAt")
    VALUES (${id}, 'tenant-a', ${propertyId}, ${phone}, 1, '2027-01-09 23:00:00', '2027-01-11 23:00:00', ${state}::"BookingStatus", (${expiry}::timestamptz AT TIME ZONE 'UTC'), 20002, NOW())`;
  const upgrade = () => context.executeMigration(migration);
  const cli = (...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
    env: { ...process.env, DATABASE_URL: context.databaseUrl }, stdio: 'pipe', encoding: 'utf8'
  });
  const unchanged = async (count: number) => {
    const rows = await context.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "Booking"`;
    assert.equal(rows[0]!.count, BigInt(count));
    const columns = await context.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Booking' AND column_name = 'reference'`;
    assert.equal(columns[0]!.count, 0n);
    const functions = await context.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace AND proname = 'booking_day'`;
    assert.equal(functions[0]!.count, 0n);
  };
  return { ...context, insert, upgrade, unchanged, cli };
}

test('Phase 3 migration preserves historical totals and unknown snapshots, including stale overlapping holds', async (t) => {
  const { db, insert, upgrade } = await legacy(t);
  await insert('confirmed');
  await insert('expired-held', 'property-a', '+2348012345678', 'HELD', new Date(Date.now() - 1));
  await insert('active-held', 'property-b', '0802 345 6789', 'HELD', new Date(Date.now() + 3600000));
  upgrade();
  const rows = await db.booking.findMany({ orderBy: { id: 'asc' } });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.reference, `LEGACY-${row.id}`);
    assert.equal(row.quoteTotalKobo, 20002n);
    assert.equal(row.quoteSnapshot, null);
    assert.equal(row.holdExtensionCount, 0);
  }
  assert.equal(rows.find((r) => r.id === 'active-held')!.guestPhone, '0802 345 6789');
  assert.equal(rows.find((r) => r.id === 'expired-held')!.status, 'HELD');
});

test('Phase 3 migration rejects invalid/conflicting legacy rows atomically', async (t) => {
  for (const scenario of ['missing-expiry', 'empty-range', 'negative-total', 'overlap', 'duplicate-phone', 'block-conflict'] as const) {
    await t.test(scenario, async (subtest) => {
      const { db, insert, upgrade, unchanged } = await legacy(subtest);
      let count = 1;
      if (scenario === 'missing-expiry') await insert('a', 'property-a', '+2348012345678', 'HELD');
      else if (scenario === 'duplicate-phone') {
        await insert('a', 'property-a', '0801 234 5678', 'HELD', new Date(Date.now() + 3600000));
        await insert('b', 'property-b', '+2348012345678', 'HELD', new Date(Date.now() + 3600000));
        count = 2;
      } else {
        await insert('a');
        if (scenario === 'overlap') { await insert('b'); count = 2; }
        if (scenario === 'empty-range') await db.$executeRaw`UPDATE "Booking" SET "checkOut" = "checkIn" WHERE id = 'a'`;
        if (scenario === 'negative-total') await db.$executeRaw`UPDATE "Booking" SET "quoteTotalKobo" = -1 WHERE id = 'a'`;
        if (scenario === 'block-conflict') await db.$executeRaw`INSERT INTO "AvailabilityBlock" (id, "tenantId", "propertyId", "startDate", "endDate", reason)
          VALUES ('block', 'tenant-a', 'property-a', '2027-01-09 23:00:00', '2027-01-11 23:00:00', 'Preserve')`;
      }
      assert.throws(upgrade, /Phase 3:/);
      await unchanged(count);
    });
  }
});

test('failed Phase 3 migrate deploy rolls back and recovers after explicit fixture repair and history resolution', async (t) => {
  const { db, insert, deploy, cli, unchanged } = await legacy(t);
  for (const name of prior) cli('migrate', 'resolve', '--applied', name);
  await insert('a');
  await insert('b');
  assert.throws(deploy, /Phase 3:|current transaction is aborted/);
  await unchanged(2);
  const history = await db.$queryRaw<{ finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = ${migration}`;
  assert.equal(history[0]!.finished_at, null);
  assert.equal(history[0]!.rolled_back_at, null);
  // Explicit resolution in a disposable fixture; real ambiguous reservations need operator review.
  await db.$executeRaw`UPDATE "Booking" SET status = 'REQUESTED' WHERE id = 'b'`;
  cli('migrate', 'resolve', '--rolled-back', migration);
  assert.match(deploy(), /All migrations have been successfully applied/);
  assert.equal(await db.booking.count(), 2);
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: 'b' } })).status, 'REQUESTED');
});
