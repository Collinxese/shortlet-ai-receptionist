import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedDatabase } from './database.js';
const prior=['20261024000100_initial','20261024000200_auth_tenant_isolation','20261024000300_properties_availability',
 '20261025000100_booking_engine','20261025000200_booking_acceptance_guards','20261025000300_payment_foundation','20261026000100_conversation_engine'];
const migration='20261028000100_usage_ledger';
const cli=(url:string,...args:string[])=>execFileSync(process.execPath,['node_modules/prisma/build/index.js',...args],{env:{...process.env,DATABASE_URL:url},stdio:'pipe',encoding:'utf8'});
test('usage migration preserves populated history and existing SQL guards and supports atomic failure/recovery',async(t)=>{
 const c=await isolatedDatabase(t);
 const directory=await mkdtemp(join(tmpdir(),'shortlet-usage-migration-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await cp('prisma',directory,{recursive:true});
 for(const name of await readdir(join(directory,'migrations'))) {
  if(name > migration && name !== 'migration_lock.toml') await rm(join(directory,'migrations',name),{recursive:true,force:true});
 }
 const deploy=()=>cli(c.databaseUrl,'migrate','deploy','--schema',join(directory,'schema.prisma'));
 for(const name of prior){c.executeMigration(name);cli(c.databaseUrl,'migrate','resolve','--applied',name);}
 await c.db.$executeRaw`INSERT INTO "Tenant" (id,name,"updatedAt") VALUES ('ledger-legacy','Legacy operator',NOW())`;
 await c.db.$executeRaw`INSERT INTO "Conversation" (id,"tenantId",channel,"externalId","updatedAt") VALUES ('ledger-legacy-chat','ledger-legacy','WHATSAPP','original',NOW())`;
 await c.db.$executeRaw`INSERT INTO "Message" (id,"tenantId","conversationId",direction,body) VALUES ('ledger-legacy-message','ledger-legacy','ledger-legacy-chat','IN','Preserved historical text')`;
 const records=async()=>({conversations:await c.db.conversation.findMany(),messages:await c.db.message.findMany()});
 const functions=()=>c.db.$queryRaw<{proname:string;definition:string;proconfig:string[];prosecdef:boolean}[]>`SELECT proname,pg_get_functiondef(oid) AS definition,proconfig,prosecdef FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY proname`;
 const catalog=async()=>({
   constraints:await c.db.$queryRaw<{name:string;definition:string}[]>`SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY conname`,
   triggers:await c.db.$queryRaw<{name:string;definition:string;enabled:string}[]>`SELECT t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.tgname`,
   indexes:await c.db.$queryRaw<{name:string;definition:string}[]>`SELECT indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname`
 });
 const before=await records(),guards=await functions(),sqlBefore=await catalog();
 await c.db.$executeRawUnsafe('CREATE FUNCTION protect_usage_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
 assert.throws(deploy,/already exists|current transaction is aborted/);
 assert.deepEqual(await records(),before);
 assert.deepEqual((await functions()).filter(f=>f.proname!=='protect_usage_event'),guards);
 const tables=await c.db.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'Usage%'`;
 assert.equal(tables[0]!.count,0n);assert.deepEqual(await catalog(),sqlBefore);
 await c.db.$executeRawUnsafe('DROP FUNCTION protect_usage_event()');
 cli(c.databaseUrl,'migrate','resolve','--rolled-back',migration);
 assert.match(deploy(),/All migrations have been successfully applied/);
 assert.deepEqual(await records(),before);
 assert.deepEqual((await functions()).filter(f=>f.proname!=='protect_usage_event'),guards);
 const protect=(await functions()).find(f=>f.proname==='protect_usage_event')!;
 assert.equal(protect.prosecdef,false);assert.deepEqual(protect.proconfig,[`search_path=pg_catalog, ${c.schema}, pg_temp`]);
 const sqlAfter=await catalog();
 for(const key of ['constraints','triggers','indexes'] as const){
   for(const row of sqlBefore[key]) assert.deepEqual(sqlAfter[key].find(r=>r.name===row.name),row);
 }
 assert.equal(await c.db.usageEvent.count(),0);assert.equal(await c.db.usageGlobalPolicy.count(),0);
 assert.match(cli(c.databaseUrl,'migrate','status','--schema',join(directory,'schema.prisma')),/Database schema is up to date/);
});
