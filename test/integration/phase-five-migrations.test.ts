import 'dotenv/config';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isolatedDatabase } from './database.js';

const prior = ['20261024000100_initial','20261024000200_auth_tenant_isolation','20261024000300_properties_availability',
  '20261025000100_booking_engine','20261025000200_booking_acceptance_guards','20261025000300_payment_foundation'];
const migration = '20261026000100_conversation_engine';
const cli = (databaseUrl: string,...args: string[]) => execFileSync(process.execPath,['node_modules/prisma/build/index.js',...args],{
  env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
});
async function legacy(t: TestContext) {
  const context = await isolatedDatabase(t);
  for (const name of prior) context.executeMigration(name);
  await context.db.$executeRaw`INSERT INTO "Tenant" (id,name,"updatedAt") VALUES ('legacy-tenant','Preserved tenant',NOW())`;
  await context.db.$executeRaw`INSERT INTO "Conversation" (id,"tenantId",channel,"externalId","handlingMode","updatedAt")
    VALUES ('legacy-conversation','legacy-tenant','WHATSAPP','existing-external','LEGACY_MODE',NOW())`;
  await context.db.$executeRaw`INSERT INTO "Message" (id,"tenantId","conversationId",direction,body)
    VALUES ('legacy-message','legacy-tenant','legacy-conversation','IN','Preserve this original message')`;
  const originals = async () => ({
    conversations: await context.db.$queryRaw`SELECT id,"tenantId",channel,"externalId","handlingMode","createdAt","updatedAt" FROM "Conversation" ORDER BY id`,
    messages: await context.db.$queryRaw`SELECT id,"tenantId","conversationId",direction,body,"createdAt" FROM "Message" ORDER BY id`
  });
  const guards = () => context.db.$queryRaw<{ proname: string; definition: string }[]>`SELECT proname,pg_get_functiondef(oid) AS definition
    FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY proname`;
  return { ...context, originals, guards, upgrade: () => context.executeMigration(migration) };
}
test('conversation migration preserves historical messages/channel/mode and existing occupancy/payment SQL functions',async (t) => {
  const { db, schema, originals, guards, upgrade } = await legacy(t);
  const before = await originals(), protectedFunctions = await guards();
  upgrade();
  assert.deepEqual(await originals(),before);
  assert.deepEqual((await guards()).filter((f) => f.proname !== 'guard_conversation_links'),protectedFunctions);
  const legacyRow = await db.conversation.findUniqueOrThrow({ where: { id: 'legacy-conversation' } });
  assert.equal(legacyRow.simulation,false); assert.equal(legacyRow.creationHash,null);
  assert.deepEqual(legacyRow.inquiry,{}); assert.deepEqual(legacyRow.propertyOptions,[]);
  assert.equal(await db.conversationTurn.count(),0); assert.equal(await db.conversationEscalation.count(),0);
  const routine = await db.$queryRaw<{ proconfig: string[]; prosecdef: boolean }[]>`SELECT proconfig,prosecdef FROM pg_proc
    WHERE pronamespace=current_schema()::regnamespace AND proname='guard_conversation_links'`;
  assert.deepEqual(routine[0]!.proconfig,[`search_path=pg_catalog, ${schema}, pg_temp`]);
  assert.equal(routine[0]!.prosecdef,false);
  // SQL CHECK treats NULL as passing; simulated identities must reject a missing replay hash explicitly.
  await assert.rejects(db.$executeRaw`INSERT INTO "Conversation" (id,"tenantId",channel,"externalId",simulation,"updatedAt")
    VALUES ('missing-replay-hash','legacy-tenant','WEBSITE','simulation:missing-hash',true,NOW())`,/Conversation_simulation_values_check/);
});
test('conversation migration fails atomically without partial columns/tables, then resolves and recovers safely',async (t) => {
  const { db, databaseUrl, originals, guards, deploy } = await legacy(t);
  for (const name of prior) cli(databaseUrl,'migrate','resolve','--applied',name);
  // Disposable-only collision forces failure near the end, after the new DDL statements.
  await db.$executeRawUnsafe('CREATE FUNCTION guard_conversation_links() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
  const before = await originals(), beforeGuards = await guards();
  assert.throws(deploy,/already exists|current transaction is aborted/);
  assert.deepEqual(await originals(),before); assert.deepEqual(await guards(),beforeGuards);
  const columns = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='Conversation' AND column_name='simulation'`;
  assert.equal(columns[0]!.count,0n);
  const tables = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name IN ('ConversationTurn','ConversationEscalation')`;
  assert.equal(tables[0]!.count,0n);
  const failed = await db.$queryRaw<{ finished_at: Date | null }[]>`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name=${migration}`;
  assert.equal(failed[0]!.finished_at,null);
  await db.$executeRawUnsafe('DROP FUNCTION guard_conversation_links()');
  cli(databaseUrl,'migrate','resolve','--rolled-back',migration);
  assert.match(deploy(),/All migrations have been successfully applied/);
  assert.deepEqual(await originals(),before);
  assert.equal(await db.conversationTurn.count(),0);
  assert.match(cli(databaseUrl,'migrate','status'),/Database schema is up to date/);
});
