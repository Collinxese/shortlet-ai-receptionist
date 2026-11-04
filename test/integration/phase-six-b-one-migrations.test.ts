import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { identityDigest } from '../../src/services/whatsapp-validation.js';
import { isolatedDatabase } from './database.js';
const migration='20261102000300_whatsapp_ownership_classification';
test('ownership migration preserves legacy provenance and SQL; injected failure rolls back all changes',async t=>{
 const c=await isolatedDatabase(t),{db}=c;
 const dir=await mkdtemp(join(tmpdir(),'ownership-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await cp('prisma',dir,{recursive:true});const path=join(dir,'schema.prisma'),migrationPath=join(dir,'migrations',migration,'migration.sql');
 const sql=await readFile(migrationPath,'utf8');await rm(join(dir,'migrations',migration),{recursive:true});
 const cli=(...args:string[])=>execFileSync(process.execPath,['node_modules/prisma/build/index.js',...args,'--schema',path],{env:{...process.env,DATABASE_URL:c.databaseUrl,SHADOW_DATABASE_URL:c.databaseUrl},encoding:'utf8',stdio:'pipe'});
 cli('migrate','deploy');
 await db.$executeRaw`INSERT INTO "Tenant" (id,name,"updatedAt") VALUES ('legacy-owner','Legacy',NOW())`;
 await db.$executeRaw`INSERT INTO "ChannelConnection" (id,"tenantId",channel,"externalBusinessId","externalPhoneNumberId","isActive","lastVerifiedAt","updatedAt") VALUES ('legacy-connection','legacy-owner','WHATSAPP','1001','2001',true,NOW(),NOW())`;
 await db.$executeRaw`INSERT INTO "Conversation" (id,"tenantId",channel,"externalId","updatedAt") VALUES ('legacy-chat','legacy-owner','WHATSAPP','legacy',NOW())`;
 const timestamp=new Date('2030-01-01T12:00:00Z'),expiry=new Date('2030-01-02T12:00:00Z'),start=new Date('2029-12-31T23:00:00Z'),end=new Date('2030-01-31T23:00:00Z');
 for(const kind of ['internal','meta','mixed']){
  const identity=identityDigest(['legacy-owner','WHATSAPP',kind]);
  await db.$executeRaw`INSERT INTO "UsageWindow" (id,"tenantId",mode,"identityHash","periodStart","periodEnd","startedAt","lastInboundAt","expiresAt") VALUES (${kind},'legacy-owner','SIMULATION',${identity},${start.toISOString()}::timestamp,${end.toISOString()}::timestamp,${timestamp.toISOString()}::timestamp,${timestamp.toISOString()}::timestamp,${expiry.toISOString()}::timestamp)`;
  if(kind!=='meta') await db.$executeRaw`INSERT INTO "UsageInbound" (id,"tenantId",mode,"eventHash","inputHash","windowId",status,"receivedAt") VALUES (${kind+'-internal'},'legacy-owner','SIMULATION',${identityDigest(kind)},${identityDigest(kind)},${kind},'ACCEPTED',${timestamp.toISOString()}::timestamp)`;
  if(kind!=='internal'){
   const messageId=kind+'-message',metaId='wamid.legacy.'+kind;
   await db.$executeRaw`INSERT INTO "Message" (id,"tenantId","conversationId",direction,body) VALUES (${messageId},'legacy-owner','legacy-chat','IN','Redacted fixture')`;
   await db.$executeRaw`INSERT INTO "WhatsAppInbound" (id,"tenantId","connectionId","phoneNumberId","metaMessageId","inputHash","conversationId","messageId","eventAt","receivedAt","usageStatus") VALUES (${kind+'-meta'},'legacy-owner','legacy-connection','2001',${metaId},${identityDigest(kind)},'legacy-chat',${messageId},${timestamp.toISOString()}::timestamp,${timestamp.toISOString()}::timestamp,'ACCEPTED')`;
   await db.$executeRaw`INSERT INTO "UsageInbound" (id,"tenantId",mode,"eventHash","inputHash","windowId",status,"receivedAt") VALUES (${kind+'-meta'},'legacy-owner','SIMULATION',${identityDigest(identityDigest(['META_WHATSAPP','2001',metaId]))},${identityDigest(kind)},${kind},'ACCEPTED',${timestamp.toISOString()}::timestamp)`;
  }
 }
 const catalog=async()=>({
  functions:await db.$queryRaw`SELECT proname,pg_get_functiondef(oid),prosecdef,proconfig,proacl::text,pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY proname`,
  constraints:await db.$queryRaw<Array<{name:string;definition:string}>>`SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY conname`,
  triggers:await db.$queryRaw`SELECT t.tgname,pg_get_triggerdef(t.oid),t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.tgname`,
  indexes:await db.$queryRaw`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname`
 });
 const records=async()=>({connections:await db.$queryRaw`SELECT * FROM "ChannelConnection" ORDER BY id`,windows:await db.$queryRaw`SELECT * FROM "UsageWindow" ORDER BY id`,receipts:await db.$queryRaw`SELECT * FROM "UsageInbound" ORDER BY id`,inbound:await db.$queryRaw`SELECT * FROM "WhatsAppInbound" ORDER BY id`,audit:await db.auditLog.findMany()});
 const before=await records(),sqlBefore=await catalog();const history=await db.$queryRaw<Array<{migration_name:string}>>`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`;
 await cp(join('prisma','migrations',migration),join(dir,'migrations',migration),{recursive:true});
 await writeFile(migrationPath,sql.replace('COMMIT;','SELECT 1/0;\nCOMMIT;'));
 assert.throws(()=>cli('migrate','deploy'),/division by zero|current transaction is aborted/i);
 assert.deepEqual(await records(),before);assert.deepEqual(await catalog(),sqlBefore);
 await writeFile(migrationPath,sql);cli('migrate','resolve','--rolled-back',migration);assert.match(cli('migrate','deploy'),/successfully applied/);
 const connection=await db.channelConnection.findUniqueOrThrow({where:{id:'legacy-connection'}});assert.equal(connection.isActive,false);assert.equal(connection.whatsappState,'PENDING_VERIFICATION');assert.equal(connection.lastVerifiedAt,null);
 const reset=await db.auditLog.findFirstOrThrow({where:{action:'whatsapp.verification_reset'}});assert.equal(reset.actorType,'SYSTEM');assert.equal(reset.tenantId,'legacy-owner');assert.equal((reset.before as {isActive:boolean}).isActive,true);
 for(const [kind,source] of [['internal','INTERNAL_SIMULATION'],['meta','META_LEGACY_UNCLASSIFIED'],['mixed','LEGACY_MIXED']]){
  const row=await db.usageWindow.findUniqueOrThrow({where:{id:kind}});assert.equal(row.source,source);assert.equal(row.startedAt.getTime(),timestamp.getTime());assert.equal(row.expiresAt.getTime(),expiry.getTime());
  assert.equal(row.identityHash,identityDigest([identityDigest(['legacy-owner','WHATSAPP',kind]),kind==='mixed'?'INTERNAL_SIMULATION':source]));
 }
 assert.equal(await db.usageInbound.count({where:{source:'META_LEGACY_UNCLASSIFIED'}}),2);assert.equal(await db.usageInbound.count({where:{source:'INTERNAL_SIMULATION'}}),2);
 assert.equal(await db.whatsAppInbound.count({where:{source:'META_LEGACY_UNCLASSIFIED'}}),2);
 const after=await catalog();for(const key of ['functions','triggers','indexes'] as const) assert.deepEqual(after[key],sqlBefore[key]);
 for(const row of sqlBefore.constraints) assert.deepEqual(after.constraints.find(r=>r.name===row.name),row);assert.equal(after.constraints.length,sqlBefore.constraints.length+4);
 const afterHistory=await db.$queryRaw<Array<{migration_name:string}>>`SELECT * FROM "_prisma_migrations" ORDER BY migration_name`;assert.deepEqual(afterHistory.filter(r=>r.migration_name!==migration),history);
 await assert.rejects(db.channelConnection.update({where:{id:connection.id},data:{isActive:true}}),/ChannelConnection_ownership_values/);
 await assert.rejects(db.usageWindow.update({where:{id:'internal'},data:{source:'META_PRODUCTION'}}),/UsageWindow_source_values/);
 assert.match(cli('migrate','status'),/Database schema is up to date/);
 let diff:string;try{diff=cli('migrate','diff','--from-schema-datasource','--to-schema-datamodel',path,'--exit-code');}catch(error){const result=error as {stdout?:Buffer;stderr?:Buffer};assert.fail(String(result.stdout ?? '')+String(result.stderr ?? ''));}assert.match(diff,/No difference detected/);
});
