import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isolatedDatabase } from './database.js';
import { lagosMidnight } from '../../src/services/calendar.js';

const prior = ['20261024000100_initial', '20261024000200_auth_tenant_isolation', '20261024000300_properties_availability',
  '20261025000100_booking_engine', '20261025000200_booking_acceptance_guards'];
const migration = '20261025000300_payment_foundation';
const cli = (databaseUrl: string, ...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
  env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
});
async function legacy(t: TestContext) {
  const context = await isolatedDatabase(t);
  for (const name of prior) context.executeMigration(name);
  const tenant = await context.db.tenant.create({ data: { name: 'Phase 4 legacy fixture' } });
  const property = await context.db.property.create({ data: { tenantId: tenant.id, name: 'Preserved room', area: 'Lagos',
    bedrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001 } });
  const booking = await context.db.booking.create({ data: { tenantId: tenant.id, propertyId: property.id, guestPhone: '+2348012345678',
    status: 'CONFIRMED', guestCount: 1, checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'),
    quoteTotalKobo: 20002, paymentReference: 'legacy-paid-reference', paymentTransactionId: 'legacy-transaction', paidAt: new Date() } });
  return { ...context, booking, upgrade: () => context.executeMigration(migration) };
}

test('Phase 4 migration preserves historical records and every existing SQL guard without fabricating payments', async (t) => {
  const { db, schema, booking, upgrade } = await legacy(t);
  const routines = await db.$queryRaw`SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
  const triggers = await db.$queryRaw`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid IN ('"Booking"'::regclass,'"AvailabilityBlock"'::regclass) AND NOT tgisinternal ORDER BY tgname`;
  upgrade();
  assert.deepEqual(await db.booking.findUniqueOrThrow({ where: { id: booking.id } }), booking);
  assert.equal(await db.payment.count(), 0); assert.equal(await db.bankTransferSetting.count(), 0);
  const after = await db.$queryRaw<{ proname: string; definition: string; proconfig: string[]; prosecdef: boolean }[]>`
    SELECT proname, pg_get_functiondef(oid) AS definition, proconfig, prosecdef FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
  assert.deepEqual(after.filter((r) => !['protect_payment_terms', 'guard_payment_confirmation'].includes(r.proname))
    .map(({ proname, definition }) => ({ proname, definition })), routines);
  assert.equal(after.length, 7);
  for (const routine of after) {
    assert.equal(routine.prosecdef, false);
    assert.deepEqual(routine.proconfig, [`search_path=pg_catalog, ${schema}, pg_temp`]);
  }
  const afterTriggers = await db.$queryRaw<{ tgname: string; definition: string }[]>`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid IN ('"Booking"'::regclass,'"AvailabilityBlock"'::regclass) AND NOT tgisinternal ORDER BY tgname`;
  assert.deepEqual(afterTriggers.filter((r) => r.tgname !== 'payment_confirmation_guard'), triggers);
  assert.match(afterTriggers.find((r) => r.tgname === 'payment_confirmation_guard')!.definition, /BEFORE INSERT OR UPDATE/);
});

test('Phase 4 migration failure rolls back all DDL and preserves old data; failed deployment can be resolved and retried', async (t) => {
  const { db, databaseUrl, booking, deploy } = await legacy(t);
  for (const name of prior) cli(databaseUrl, 'migrate', 'resolve', '--applied', name);
  // Disposable-only name collision injects a failure near the end of the migration.
  await db.$executeRawUnsafe('CREATE FUNCTION guard_payment_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
  const before = await db.$queryRaw`SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
  assert.throws(deploy, /already exists|current transaction is aborted/);
  assert.deepEqual(await db.booking.findUniqueOrThrow({ where: { id: booking.id } }), booking);
  const tables = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()
    AND table_name IN ('Payment','BankTransferSetting')`;
  assert.equal(tables[0]!.count, 0n);
  const types = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_type WHERE typnamespace = current_schema()::regnamespace
    AND typname IN ('PaymentStatus','PaymentMethod')`;
  assert.equal(types[0]!.count, 0n);
  assert.deepEqual(await db.$queryRaw`SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`, before);
  const history = await db.$queryRaw<{ finished_at: Date | null }[]>`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = ${migration}`;
  assert.equal(history[0]!.finished_at, null);
  await db.$executeRawUnsafe('DROP FUNCTION guard_payment_confirmation()');
  cli(databaseUrl, 'migrate', 'resolve', '--rolled-back', migration);
  assert.match(deploy(), /All migrations have been successfully applied/);
  assert.equal(await db.payment.count(), 0);
  assert.deepEqual(await db.booking.findUniqueOrThrow({ where: { id: booking.id } }), booking);
  assert.match(cli(databaseUrl, 'migrate', 'status'), /Database schema is up to date/);
});
