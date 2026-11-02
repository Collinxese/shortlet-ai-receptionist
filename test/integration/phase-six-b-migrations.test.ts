import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { isolatedDatabase } from './database.js';
const migration='20261102000100_whatsapp_inbound';
const cli=(url:string,...args:string[])=>execFileSync(process.execPath,['node_modules/prisma/build/index.js',...args],{env:{...process.env,DATABASE_URL:url},stdio:'pipe',encoding:'utf8'});
test('WhatsApp migration rejects ambiguous legacy mappings atomically and preserves data/history/SQL on recovery',async t=>{
 const c=await isolatedDatabase(t);
 for(const name of (await readdir('prisma/migrations')).filter(n=>n<migration).sort()) {c.executeMigration(name);cli(c.databaseUrl,'migrate','resolve','--applied',name);}
 await c.db.$executeRaw`INSERT INTO "Tenant" (id,name,"updatedAt") VALUES ('meta-legacy-a','Legacy A',NOW()),('meta-legacy-b','Legacy B',NOW())`;
 await c.db.$executeRaw`INSERT INTO "ChannelConnection" (id,"tenantId",channel,"externalBusinessId","externalPhoneNumberId","isActive","updatedAt")
 VALUES ('legacy-meta-a','meta-legacy-a','WHATSAPP','1001','2001',true,NOW()),('legacy-meta-b','meta-legacy-b','WHATSAPP','1002','2001',false,NOW()),
 ('legacy-meta-null','meta-legacy-a','WHATSAPP','1003',NULL,true,NOW())`;
 await c.db.$executeRaw`INSERT INTO "Conversation" (id,"tenantId",channel,"externalId","updatedAt") VALUES ('legacy-meta-chat','meta-legacy-a','WHATSAPP','old',NOW())`;
 await c.db.$executeRaw`INSERT INTO "Message" (id,"tenantId","conversationId",direction,body) VALUES ('legacy-meta-message','meta-legacy-a','legacy-meta-chat','IN','Historical fixture')`;
 const functions=()=>c.db.$queryRaw<Array<{name:string;definition:string;security:boolean;config:string[];owner:string;acl:unknown}>>`SELECT proname AS name,pg_get_functiondef(oid) AS definition,prosecdef AS security,proconfig AS config,pg_get_userbyid(proowner) AS owner,proacl::text AS acl FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY proname`;
 const catalog=async()=>({
  constraints:await c.db.$queryRaw<Array<{name:string;definition:string}>>`SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY conname`,
  indexes:await c.db.$queryRaw<Array<{name:string;definition:string}>>`SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname`,
  triggers:await c.db.$queryRaw<Array<{name:string;definition:string;enabled:string}>>`SELECT t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.tgname`
 });
 const records=async()=>({connections:await c.db.channelConnection.findMany({orderBy:{id:'asc'}}),conversations:await c.db.conversation.findMany(),messages:await c.db.message.findMany()});
 const before=await records(),sqlBefore=await catalog(),functionsBefore=await functions();
 const historyBefore=await c.db.$queryRaw<Array<{migration_name:string}>>`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`;
 const assertRollback=async()=>{
  assert.deepEqual(await catalog(),sqlBefore);assert.deepEqual(await functions(),functionsBefore);
  const table=await c.db.$queryRaw<Array<{present:boolean}>>`SELECT to_regclass('"WhatsAppInbound"') IS NOT NULL AS present`;assert.equal(table[0]!.present,false);
 };
 assert.throws(c.deploy,/unique|duplicat|current transaction is aborted/i);await assertRollback();assert.deepEqual(await records(),before);
 // Repair only disposable fixture data; inactive duplicate ownership is also ambiguous.
 await c.db.$executeRaw`UPDATE "ChannelConnection" SET "externalPhoneNumberId"='2002' WHERE id='legacy-meta-b'`;
 cli(c.databaseUrl,'migrate','resolve','--rolled-back',migration);
 assert.throws(c.deploy,/ChannelConnection_whatsapp_values|current transaction is aborted/);await assertRollback();
 await c.db.$executeRaw`UPDATE "ChannelConnection" SET "isActive"=false WHERE id='legacy-meta-null'`;
 const repaired=await records();cli(c.databaseUrl,'migrate','resolve','--rolled-back',migration);
 assert.match(c.deploy(),/All migrations have been successfully applied/);assert.deepEqual(await records(),repaired);
 const after=await catalog();
 for(const key of ['constraints','triggers','indexes'] as const) for(const row of sqlBefore[key]) {
  if(key==='indexes' && row.name==='ChannelConnection_channel_externalBusinessId_key') continue;
  assert.deepEqual(after[key].find(r=>r.name===row.name),row);
 }
 assert.ok(after.indexes.some(r=>r.name==='ChannelConnection_other_business_key'));
 assert.ok(after.indexes.some(r=>r.name==='ChannelConnection_channel_externalPhoneNumberId_key'));
 const functionsAfter=await functions();assert.deepEqual(functionsAfter.filter(f=>f.name!=='protect_whatsapp_connection'),functionsBefore);
 const guard=functionsAfter.find(f=>f.name==='protect_whatsapp_connection')!;assert.equal(guard.security,false);assert.deepEqual(guard.config,[`search_path=pg_catalog, ${c.schema}, pg_temp`]);
 const historyAfter=await c.db.$queryRaw<Array<{migration_name:string}>>`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`;
 assert.deepEqual(historyAfter.filter(r=>r.migration_name!==migration),historyBefore);
 assert.equal(await c.db.whatsAppInbound.count(),0);
 assert.match(cli(c.databaseUrl,'migrate','status'),/Database schema is up to date/);
 const diff=cli(c.databaseUrl,'migrate','diff','--from-url',c.databaseUrl,'--to-schema-datamodel','prisma/schema.prisma','--exit-code');assert.match(diff,/No difference detected/);
});
