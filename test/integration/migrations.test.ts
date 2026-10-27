import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

async function starterDatabase(t: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL test database.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  const schema = `phase1_test_${randomBytes(8).toString('hex')}`;
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  t.after(async () => {
    try {
      // Only the randomly generated schema created by this test is removed.
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await db.$disconnect(); }
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const executeMigration = (directory: string) => execFileSync(process.execPath, [
    'node_modules/prisma/build/index.js', 'db', 'execute', '--schema', 'prisma/schema.prisma',
    '--file', `prisma/migrations/${directory}/migration.sql`
  ], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe', encoding: 'utf8' });
  executeMigration('20261024000100_initial');
  await db.$executeRaw`INSERT INTO "Tenant" (id, name, "updatedAt") VALUES ('tenant-a', 'A', NOW()), ('tenant-b', 'B', NOW())`;
  await db.$executeRaw`INSERT INTO "User" (id, "tenantId", name, email, "passwordHash", role, "updatedAt")
    VALUES ('owner-a', 'tenant-a', 'Owner A', 'OWNER-A@EXAMPLE.COM', 'legacy-test-only', 'OWNER', NOW())`;
  return { db, upgrade: () => executeMigration('20261024000200_auth_tenant_isolation') };
}

test('Phase 1 migration preserves existing messages and normalizes operator email', async (t) => {
  const { db, upgrade } = await starterDatabase(t);
  await db.$executeRaw`INSERT INTO "Conversation" (id, "tenantId", channel, "externalId", "updatedAt")
    VALUES ('conversation-a', 'tenant-a', 'WEBSITE', 'fixture', NOW())`;
  await db.$executeRaw`INSERT INTO "Message" (id, "conversationId", direction, body)
    VALUES ('message-a', 'conversation-a', 'IN', 'Preserve this fixture')`;
  upgrade();
  const message = await db.message.findUniqueOrThrow({ where: { id: 'message-a' }, select: { tenantId: true, body: true } });
  assert.equal(message.tenantId, 'tenant-a');
  assert.equal(message.body, 'Preserve this fixture');
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: 'owner-a' } })).email, 'owner-a@example.com');
  assert.equal(await db.authSession.count(), 0);
});

test('duplicate normalized emails stop migration without changing existing records', async (t) => {
  const { db, upgrade } = await starterDatabase(t);
  await db.$executeRaw`INSERT INTO "User" (id, "tenantId", name, email, "passwordHash", role, "updatedAt")
    VALUES ('owner-b', 'tenant-b', 'Owner B', 'owner-a@example.com', 'legacy-test-only', 'OWNER', NOW())`;
  assert.throws(upgrade, /Resolve duplicate normalized operator emails/);
  const rows = await db.$queryRaw<{ email: string }[]>`SELECT email FROM "User" WHERE id = 'owner-a'`;
  assert.equal(rows[0]?.email, 'OWNER-A@EXAMPLE.COM');
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Message' AND column_name = 'tenantId'`;
  assert.equal(columns[0]?.count, 0n);
});

test('existing cross-tenant parent references stop migration and roll back earlier changes', async (t) => {
  const { db, upgrade } = await starterDatabase(t);
  await db.$executeRaw`INSERT INTO "Property" (id, "tenantId", name, area, "maxGuests", bedrooms, "baseNightlyPriceKobo", "updatedAt")
    VALUES ('property-b', 'tenant-b', 'B fixture', 'Lagos', 2, 1, 10000, NOW())`;
  await db.$executeRaw`INSERT INTO "PriceRule" (id, "tenantId", "propertyId", label, "nightlyPriceKobo")
    VALUES ('bad-rule', 'tenant-a', 'property-b', 'Existing inconsistent fixture', 10000)`;
  assert.throws(upgrade, /foreign key constraint/);
  const rows = await db.$queryRaw<{ email: string }[]>`SELECT email FROM "User" WHERE id = 'owner-a'`;
  assert.equal(rows[0]?.email, 'OWNER-A@EXAMPLE.COM');
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Message' AND column_name = 'tenantId'`;
  assert.equal(columns[0]?.count, 0n);
});
