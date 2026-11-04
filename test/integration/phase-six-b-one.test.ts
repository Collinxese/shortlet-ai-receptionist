import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { publicUserSelect, type AuthContext } from '../../src/services/authentication.js';
import { GraphWhatsAppOwnership, MetaCredentialStore, type WhatsAppOwnership } from '../../src/services/whatsapp-ownership.js';
import { WhatsAppConnections } from '../../src/services/whatsapp-connections.js';
import { WhatsAppWebhook } from '../../src/services/whatsapp-webhook.js';
import { UsageService } from '../../src/services/usage-service.js';
import { developmentUsagePolicy } from '../../src/services/usage-validation.js';
import { bodyDigest } from '../../src/services/whatsapp-validation.js';
import { isolatedDatabase } from './database.js';
const secret='synthetic-only-app-secret',accessToken='synthetic-only-meta-token';
test('Phase 6B.1 ownership boundary, trusted classification and disabled production',async t=>{
 const {db,databaseUrl,deploy}=await isolatedDatabase(t);deploy();let seq=0;
 let now=new Date('2030-01-31T22:00:00Z');const clock=()=>now;
 const actor=async(role:'OWNER'|'MANAGER'|'RECEPTIONIST',tenantId?:string)=>{
  tenantId??=(await db.tenant.create({data:{name:'Ownership fixture'}})).id;
  const user=await db.user.create({data:{tenantId,name:'Fixture',role,email:`ownership-${++seq}@example.com`,passwordHash:'synthetic-only'},select:publicUserSelect});
  const token=randomBytes(32).toString('base64url');await db.authSession.create({data:{tenantId,userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  return {auth:{user,sessionId:'fixture'} satisfies AuthContext,token};
 };
 const a=await actor('OWNER'),b=await actor('OWNER'),manager=await actor('MANAGER',a.auth.user.tenantId),reception=await actor('RECEPTIONIST',a.auth.user.tenantId);
 const dir=await mkdtemp(join(tmpdir(),'meta-integration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'credentials.json');
 const grant={tenantId:a.auth.user.tenantId,businessId:'1001',phoneNumberId:'2001',environment:'META_TEST',accessToken};
 const production={...grant,phoneNumberId:'2002',environment:'META_PRODUCTION'};
 const save=async(grants:object[]=[grant,production])=>writeFile(file,JSON.stringify(grants),{mode:0o600});await save();
 let authorized=true,calls=0;
 const fetcher:typeof fetch=async(input)=>{calls++;const url=new URL(String(input));
  if(!authorized) return Response.json({error:accessToken},{status:401});
  if(url.pathname.endsWith('/debug_token')) return Response.json({data:{is_valid:true,app_id:'3001',scopes:['whatsapp_business_management'],expires_at:0,data_access_expires_at:0}});
  if(url.pathname.endsWith('/phone_numbers')) return Response.json({data:[{id:'2001'},{id:'2002'}]});
  return Response.json({id:'1001'});
 };
 const ownership=new GraphWhatsAppOwnership(new MetaCredentialStore(file),{appId:'3001',appSecret:secret,version:'v23.0'},fetcher,clock);
 const service=new WhatsAppConnections(db,a.auth,ownership,undefined,clock);
 const app=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl}),{db,logger:false,whatsappOwnership:ownership});t.after(()=>app.close());
 const req=(method:'GET'|'POST'|'PATCH',path:string,who=a,payload?:object)=>app.inject({method,url:'/api/whatsapp/connections'+path,headers:{authorization:`Bearer ${who.token}`},payload});
 const payload=(phone='2001',from='2348091111111',id=`wamid.ownership.${++seq}`)=>({object:'whatsapp_business_account',entry:[{id:'1001',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phone},messages:[{from,id,timestamp:String(now.getTime()/1000),type:'text',text:{body:'Hello'}}]}}]}]});
 const deliver=async(p:object,enabled=false)=>{const raw=JSON.stringify(p);await new WhatsAppWebhook(db,secret,clock,ownership,enabled?{allowsProduction:()=>true}:undefined).receive(Buffer.from(raw),'sha256='+createHmac('sha256',secret).update(raw).digest('hex'));return (await db.webhookEvent.findUniqueOrThrow({where:{provider_eventId:{provider:'META_WHATSAPP',eventId:bodyDigest(raw)}}})).rawBody as {outcomes:Record<string,number>};};
 let id:string;
 await t.test('new pending mapping cannot activate or accept messages; field and tenant spoofing rejected',async()=>{
  const r=await req('POST','',a,{phoneNumberId:'2001',businessId:'1001'});assert.equal(r.statusCode,201);id=r.json().connection.id;
  assert.equal(r.json().connection.whatsappState,'PENDING_VERIFICATION');assert.equal(r.json().connection.isActive,false);
  assert.equal((await req('PATCH',`/${id}`,a,{isActive:true})).statusCode,409);
  assert.equal((await req('POST','',a,{phoneNumberId:'2999',businessId:'1001',isActive:true})).statusCode,400);
  for(const patch of [{whatsappState:'VERIFIED'},{lastVerifiedAt:now.toISOString()},{whatsappEnvironment:'META_TEST'},{credentialDigest:'a'.repeat(64)},{tenantId:b.auth.user.tenantId}]){
   assert.equal((await req('PATCH',`/${id}`,manager,patch)).statusCode,400);
   assert.equal((await req('POST',`/${id}/verify`,manager,patch)).statusCode,400);
  }
  assert.equal((await deliver(payload())).outcomes.UNVERIFIED_NUMBER,1);assert.equal(await db.conversation.count(),0);assert.equal(await db.usageInbound.count(),0);
 });
 await t.test('roles, cross-tenant verification and missing credentials fail safely',async()=>{
  assert.equal((await req('POST',`/${id}/verify`,b)).statusCode,404);
  assert.equal((await req('POST',`/${id}/verify`,reception)).statusCode,403);
  const missing=await service.create({phoneNumberId:'2999',businessId:'1001'});
  await assert.rejects(service.verify(missing.id),/META_OWNERSHIP_UNAVAILABLE/);
  assert.equal((await db.channelConnection.findUniqueOrThrow({where:{id:missing.id}})).whatsappState,'PENDING_VERIFICATION');
  authorized=false;await assert.rejects(service.verify(id),/META_OWNERSHIP_VERIFICATION_FAILED/);authorized=true;
  assert.equal((await db.channelConnection.findUniqueOrThrow({where:{id}})).isActive,false);
  const audit=await db.auditLog.findFirstOrThrow({where:{entityId:id,action:'whatsapp.verification_failed'}});assert.equal(audit.actorId,a.auth.user.id);assert.equal(audit.tenantId,a.auth.user.tenantId);
 });
 await t.test('server Graph proof permits VERIFIED then explicit ACTIVE; responses and audit omit secrets',async()=>{
  const response=await req('POST',`/${id}/verify`,manager);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().connection.whatsappState,'VERIFIED');assert.equal(response.json().connection.isActive,false);
  assert.equal((await req('PATCH',`/${id}`,manager,{isActive:true})).statusCode,200);
  const text=JSON.stringify([response.json(),(await req('GET','')).json(),await db.auditLog.findMany()]);
  for(const hidden of [accessToken,secret,'credentialDigest','verificationAttempt']) assert.ok(!text.includes(hidden));
  assert.ok(calls>=3);
 });
 await t.test('Meta test and internal windows stay separate for the same guest; no allowance or AI cost consumption',async()=>{
  const usage=new UsageService(db,a.auth,{developmentDefaults:true},clock);
  const receipt=await usage.recordInbound({phone:'+2348091111111',eventId:'internal-inbound-1'});
  assert.equal(receipt.source,'INTERNAL_SIMULATION');
  const p=payload();await Promise.all([deliver(p),deliver(p),deliver({...p,extra:true})]);
  const testRow=await db.usageInbound.findFirstOrThrow({where:{source:'META_TEST'}});assert.equal(testRow.mode,'SIMULATION');assert.equal(testRow.status,'ACCEPTED');assert.notEqual(testRow.windowId,receipt.windowId);
  const window=await db.usageWindow.findUniqueOrThrow({where:{id:testRow.windowId!}});
  now=new Date(now.getTime()+600000);await deliver({...p,extra:'retry'});assert.equal((await db.usageWindow.findUniqueOrThrow({where:{id:window.id}})).expiresAt.getTime(),window.expiresAt.getTime());
  assert.equal(await db.usageInbound.count({where:{source:'META_TEST'}}),1);assert.equal(await db.usageWindow.count({where:{mode:'PRODUCTION'}}),0);
  const summary=await usage.summary('SIMULATION');assert.equal(summary.conversations,1);assert.ok(summary.ticketsBySource.some((r:{source:string})=>r.source==='META_TEST'));assert.equal(summary.accountedMicroUsd,'0');
  await db.usagePolicy.update({where:{tenantId_mode:{tenantId:a.auth.user.tenantId,mode:'SIMULATION'}},data:{conversationAllowance:0}});
  await deliver(payload('2001','2348092222222'));assert.equal(await db.usageWindow.count({where:{source:'META_TEST'}}),2);
  assert.equal(await db.usageEvent.count(),0);assert.equal(await db.conversationTurn.count(),0);
 });
 await t.test('secret removal/rotation, verification expiry and failed re-verification stop ingress',async()=>{
  await save([{...grant,accessToken:'synthetic-rotated-token'},production]);
  assert.equal((await deliver(payload())).outcomes.VERIFICATION_REVOKED,1);await assert.rejects(service.update(id,{isActive:true}),/OWNERSHIP_VERIFICATION_REQUIRED/);await save();
  now=new Date('2030-02-01T22:00:00Z');assert.equal((await deliver(payload())).outcomes.VERIFICATION_EXPIRED,1);
  authorized=false;await assert.rejects(service.verify(id),/META_OWNERSHIP_VERIFICATION_FAILED/);authorized=true;
  assert.equal((await deliver(payload())).outcomes.UNVERIFIED_NUMBER,1);
  await service.verify(id);await service.update(id,{isActive:true});
 });
 await t.test('deactivation cancels in-flight verification and audit failures roll back successful proof',async()=>{
  let release!:()=>void,started!:()=>void;const start=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
  const slow:WhatsAppOwnership={...ownership,current:ownership.current.bind(ownership),async verify(c){started();await wait;return ownership.verify(c);}};
  const pending=new WhatsAppConnections(db,a.auth,slow,undefined,clock).verify(id);await start;await service.update(id,{isActive:false});release();await assert.rejects(pending,/VERIFICATION_SUPERSEDED/);
  assert.equal((await db.channelConnection.findUniqueOrThrow({where:{id}})).whatsappState,'PENDING_VERIFICATION');
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_ownership_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='whatsapp.ownership_verified' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fail_ownership_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_ownership_audit()');
  try{await assert.rejects(service.verify(id),/META_OWNERSHIP_VERIFICATION_FAILED/);assert.equal((await db.channelConnection.findUniqueOrThrow({where:{id}})).whatsappState,'PENDING_VERIFICATION');}
  finally{await db.$executeRawUnsafe('DROP TRIGGER fail_ownership_audit ON "AuditLog"');await db.$executeRawUnsafe('DROP FUNCTION fail_ownership_audit()');}
 });
 await t.test('verification provider failures cannot leak token or app secret into API responses or access logs',async()=>{
  const script=`import {buildApp} from './src/app.ts';import {loadConfig} from './src/config.ts';
   import {GraphWhatsAppOwnership,MetaCredentialStore} from './src/services/whatsapp-ownership.ts';
   const verifier=new GraphWhatsAppOwnership(new MetaCredentialStore(${JSON.stringify(file)}),
    {appId:'3001',appSecret:${JSON.stringify(secret)},version:'v23.0'},async()=>{throw new Error(${JSON.stringify(accessToken+secret)});});
   const app=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:${JSON.stringify(databaseUrl)}}),{whatsappOwnership:verifier});
   const response=await app.inject({method:'POST',url:${JSON.stringify('/api/whatsapp/connections/'+id+'/verify')},headers:{authorization:${JSON.stringify('Bearer '+a.token)}}});
   console.log(response.statusCode,response.body);await app.close();`;
  const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...process.env,AI_PROVIDER:'mock',PAYSTACK_TEST_ENABLED:'false'},encoding:'utf8'});
  assert.match(output,/503/);assert.match(output,/META_OWNERSHIP_VERIFICATION_FAILED/);assert.match(output,/incoming request/);
  for(const marker of [accessToken,secret,a.token]) assert.ok(!output.includes(marker));
 });
 await t.test('production activation denied by default; explicit test-only policy exercises existing allowance and Lagos periods',async()=>{
  const row=await service.create({phoneNumberId:'2002',businessId:'1001'});await service.verify(row.id);
  await assert.rejects(service.update(row.id,{isActive:true}),/PRODUCTION_WHATSAPP_DISABLED/);
  // An injected policy in this disposable test is the only enabled path; app wiring has no switch.
  await new WhatsAppConnections(db,a.auth,ownership,{allowsProduction:()=>true},clock).update(row.id,{isActive:true});
  const denied=await deliver(payload('2002'));assert.equal(denied.outcomes.PRODUCTION_DISABLED,1);assert.equal(await db.usageInbound.count({where:{mode:'PRODUCTION'}}),0);
  const missing=payload('2002');await deliver(missing,true);assert.equal((await db.usageInbound.findFirstOrThrow({where:{mode:'PRODUCTION'}})).status,'BLOCKED');assert.equal(await db.usageWindow.count({where:{mode:'PRODUCTION'}}),0);
  await db.usagePolicy.create({data:{...developmentUsagePolicy(),tenantId:a.auth.user.tenantId,mode:'PRODUCTION',conversationAllowance:1}});
  const p=payload('2002');await Promise.all([deliver(p,true),deliver(p,true),deliver({...p,extra:true},true)]);
  const accepted=await db.usageInbound.findMany({where:{source:'META_PRODUCTION',status:'ACCEPTED'}});assert.equal(accepted.length,1);
  const w=await db.usageWindow.findUniqueOrThrow({where:{id:accepted[0]!.windowId!}});assert.equal(w.periodStart.toISOString(),'2030-01-31T23:00:00.000Z');
  await deliver(payload('2002','2348093333333'),true);assert.equal(await db.usageWindow.count({where:{mode:'PRODUCTION'}}),1);assert.equal(await db.usageInbound.count({where:{mode:'PRODUCTION',status:'BLOCKED'}}),2);
  now=new Date(now.getTime()+60000);await deliver({...p,extra:'later'},true);assert.equal((await db.usageWindow.findUniqueOrThrow({where:{id:w.id}})).expiresAt.getTime(),w.expiresAt.getTime());
  assert.equal((await new UsageService(db,a.auth,{developmentDefaults:false},clock).summary('PRODUCTION')).conversations,1);
  assert.equal(await db.usageEvent.count(),0);assert.equal(await db.message.count({where:{direction:'OUT'}}),0);
 });
});
