import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { isolatedDatabase } from './database.js';
import { BookingService } from '../../src/services/booking-service.js';
import { lagosMidnight } from '../../src/services/calendar.js';

const prior = ['20261024000100_initial', '20261024000200_auth_tenant_isolation',
  '20261024000300_properties_availability', '20261025000100_booking_engine'];
const migration = '20261025000200_booking_acceptance_guards';
const cli = (databaseUrl: string, ...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
  env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
});

async function phaseThree(t: TestContext) {
  const context = await isolatedDatabase(t);
  for (const name of prior) context.executeMigration(name);
  const tenant = await context.db.tenant.create({ data: { name: 'Acceptance legacy' } });
  const actor = await context.db.user.create({ data: { tenantId: tenant.id, email: 'acceptance-legacy@example.com',
    name: 'Legacy owner', passwordHash: 'test-only-fixture', role: 'OWNER' } });
  const rooms = await Promise.all([1, 2].map((index) => context.db.property.create({ data: {
    tenantId: tenant.id, name: `Legacy ${index}`, area: 'Lagos', bedrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001
  } })));
  const hold = (propertyId: string, phone: string, expiresAt = new Date(Date.now() + 3600000)) => context.db.booking.create({ data: {
    tenantId: tenant.id, propertyId, guestPhone: phone, guestCount: 1, status: 'HELD', quoteTotalKobo: 20002,
    checkIn: lagosMidnight('2027-01-10'), checkOut: lagosMidnight('2027-01-12'), holdExpiresAt: expiresAt
  } });
  return { ...context, tenant, actor, rooms, hold, upgrade: () => context.executeMigration(migration) };
}

async function catalog(db: PrismaClient) {
  const constraints = await db.$queryRaw`SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY conname`;
  const triggers = await db.$queryRaw`SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`;
  const functions = await db.$queryRaw`SELECT proname, prosecdef, proconfig, pg_get_functiondef(oid) AS definition
    FROM pg_proc WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
  const indexes = await db.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`;
  return { constraints, triggers, functions, indexes };
}

test('acceptance migration preserves populated booking terms, records and financial fields without inventing data', async (t) => {
  const { db, schema, actor, rooms, hold, upgrade } = await phaseThree(t);
  await hold(rooms[0]!.id, '\t08012345678\n');
  await hold(rooms[1]!.id, '+2348012345678', new Date(Date.now() - 1)); // Expired duplicate is allowed.
  const service = new BookingService(db, { user: actor, sessionId: 'test-only' });
  await service.create('REQUESTED', { propertyId: rooms[0]!.id, guestName: 'Legacy inquiry', guestPhone: '+2348099999999', guestCount: 1,
    checkIn: '2027-02-01', checkOut: '2027-02-03' }, 'acceptance-preserve-quote');
  const before = await db.booking.findMany({ orderBy: { id: 'asc' } });
  const operations = await db.bookingOperation.findMany();
  const audit = await db.auditLog.findMany();
  upgrade();
  assert.deepEqual(await db.booking.findMany({ orderBy: { id: 'asc' } }), before);
  assert.deepEqual(await db.bookingOperation.findMany(), operations);
  assert.deepEqual(await db.auditLog.findMany(), audit);
  const functions = await db.$queryRaw<{ proname: string; prosecdef: boolean; proconfig: string[] }[]>`
    SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = current_schema()::regnamespace ORDER BY proname`;
  assert.equal(functions.length, 5);
  for (const routine of functions) {
    assert.equal(routine.prosecdef, false);
    assert.deepEqual(routine.proconfig, [`search_path=pg_catalog, ${schema}, pg_temp`]);
  }
});

test('acceptance migration rejects newly equivalent active phones atomically and supports failed-deploy recovery', async (t) => {
  const { db, databaseUrl, rooms, hold, deploy } = await phaseThree(t);
  for (const name of prior) cli(databaseUrl, 'migrate', 'resolve', '--applied', name);
  await hold(rooms[0]!.id, '\t08022345678\n');
  const duplicate = await hold(rooms[1]!.id, '+2348022345678');
  const beforeRows = await db.booking.findMany({ orderBy: { id: 'asc' } });
  const beforeCatalog = await catalog(db);
  assert.throws(deploy, /Phase 3 acceptance:|current transaction is aborted/);
  assert.deepEqual(await db.booking.findMany({ orderBy: { id: 'asc' } }), beforeRows);
  // Function replacements and search_path settings roll back together with failure.
  // Migration-history metadata is intentionally excluded from this comparison.
  assert.deepEqual(await catalog(db), beforeCatalog);
  const history = await db.$queryRaw<{ finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = ${migration}`;
  assert.equal(history[0]!.finished_at, null);
  assert.equal(history[0]!.rolled_back_at, null);
  // Explicit disposable-fixture repair; never automatically cancel real guest holds.
  await db.booking.update({ where: { id: duplicate.id }, data: { holdExpiresAt: new Date(Date.now() - 1) } });
  cli(databaseUrl, 'migrate', 'resolve', '--rolled-back', migration);
  assert.match(deploy(), /All migrations have been successfully applied/);
  assert.equal(await db.booking.count(), 2);
  const phone = await db.$queryRaw<{ phone: string }[]>`SELECT booking_phone(${ '\t08022345678\n' }) AS phone`;
  assert.equal(phone[0]!.phone, '+2348022345678');
});

test('Prisma shadow replay and an appended generated migration preserve all SQL-only safeguards', async (t) => {
  const target = await isolatedDatabase(t), shadow = await isolatedDatabase(t);
  target.deploy();
  const before = await catalog(target.db);
  const originalSchema = await readFile('prisma/schema.prisma', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'shortlet-acceptance-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp('prisma/migrations', join(directory, 'migrations'), { recursive: true });
  const schemaPath = join(directory, 'schema.prisma');
  // Test-only nullable column in a temporary schema copy, never a product change.
  await writeFile(schemaPath, originalSchema.replace('model Booking {', 'model Booking {\n  acceptanceAuditProbe String?'));
  // Match the model's default schema to the replay schema during diff. Different
  // generated schema names would describe a schema move rather than a new column.
  const generated = cli(shadow.databaseUrl, 'migrate', 'diff', '--from-migrations', 'prisma/migrations',
    '--to-schema-datamodel', schemaPath, '--shadow-database-url', shadow.databaseUrl, '--script');
  assert.match(generated, /ADD COLUMN\s+"acceptanceAuditProbe"\s+TEXT/);
  assert.doesNotMatch(generated, /DROP (?:TRIGGER|FUNCTION|CONSTRAINT|INDEX)/);
  const nextMigration = join(directory, 'migrations', '20261026000200_acceptance_probe');
  await mkdir(nextMigration);
  await writeFile(join(nextMigration, 'migration.sql'), generated);
  assert.match(cli(target.databaseUrl, 'migrate', 'deploy', '--schema', schemaPath), /All migrations have been successfully applied/);
  assert.deepEqual(await catalog(target.db), before);
  assert.match(cli(target.databaseUrl, 'migrate', 'status', '--schema', schemaPath), /Database schema is up to date/);
  const probe = await target.db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Booking' AND column_name = 'acceptanceAuditProbe'`;
  assert.equal(probe[0]!.count, 1n);
  assert.equal(await readFile('prisma/schema.prisma', 'utf8'), originalSchema);
});
