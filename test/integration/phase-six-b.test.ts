import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { publicUserSelect, type AuthContext } from '../../src/services/authentication.js';
import { UsageService } from '../../src/services/usage-service.js';
import { WhatsAppConnections } from '../../src/services/whatsapp-connections.js';
import { WhatsAppWebhook } from '../../src/services/whatsapp-webhook.js';
import { bodyDigest, identityDigest } from '../../src/services/whatsapp-validation.js';
import { fixtureOwnership } from '../fixtures/whatsapp-ownership.js';
import { isolatedDatabase } from './database.js';
const secret='synthetic-meta-app-secret-fixture',token='synthetic-verify-token-fixture-00001';
test('Phase 6B signed inbound delivery, isolation, atomic persistence and ledger integration',async t=>{
 const {db,databaseUrl,deploy}=await isolatedDatabase(t);deploy();
 const ownership=fixtureOwnership();
 let now=new Date();let seq=0;const clock=()=>new Date(now);
 let calls=0;const app=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl,META_WEBHOOK_ENABLED:'true',META_APP_SECRET:secret,META_VERIFY_TOKEN:token}),
 {db,logger:false,whatsappOwnership:ownership,conversationModel:{name:'mock',async plan(){calls++;throw new Error('MODEL_MUST_NOT_RUN');}}});t.after(()=>app.close());
 const actors: Array<{auth:AuthContext;token:string}>=[];
 const actor=async(role:'OWNER'|'MANAGER'|'RECEPTIONIST',tenantId?:string)=>{
  const tenant=tenantId ?? (await db.tenant.create({data:{name:`Fixture ${++seq}`}})).id;
  const user=await db.user.create({data:{tenantId:tenant,role,name:'Synthetic operator',email:`meta-fixture-${++seq}@example.com`,passwordHash:'synthetic-only'},select:publicUserSelect});
  const token=randomBytes(32).toString('base64url');
  await db.authSession.create({data:{tenantId:tenant,userId:user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  const entry={auth:{user,sessionId:'fixture'} satisfies AuthContext,token};actors.push(entry);return entry;
 };
 const a=await actor('OWNER'),b=await actor('OWNER'),manager=await actor('MANAGER',a.auth.user.tenantId),reception=await actor('RECEPTIONIST',a.auth.user.tenantId);
 const req=(method:'GET'|'POST'|'PATCH',path:string,who=a,payload?:object)=>app.inject({method,url:'/api'+path,headers:{authorization:`Bearer ${who.token}`},payload});
 const mapping=(who=a)=>{
  const service=new WhatsAppConnections(db,who.auth,ownership);
  return {create:async(input:{phoneNumberId:string;businessId:string;isActive?:boolean})=>{
   const row=await service.create({...input,isActive:false});await service.verify(row.id);
   return input.isActive ? service.update(row.id,{isActive:true}):service.update(row.id,{isActive:false});
  }};
 };
 const first=await mapping().create({phoneNumberId:'2001',businessId:'1001',isActive:true});
 const other=await mapping(b).create({phoneNumberId:'2002',businessId:'1001',isActive:true});
 await new UsageService(db,a.auth).summary('SIMULATION');await new UsageService(db,b.auth).summary('SIMULATION');
 const message=(patch={})=>({from:'2348091234567',id:`wamid.fixture.${++seq}`,timestamp:String(Math.floor(now.getTime()/1000)),type:'text',text:{body:'Hello, availability please'},...patch});
 const value=(messages=[message()],phone='2001')=>({messaging_product:'whatsapp',metadata:{phone_number_id:phone},messages});
 const payload=(v:object=value(),field='messages',business='1001')=>({object:'whatsapp_business_account',entry:[{id:business,changes:[{field,value:v}]}]});
 const sign=(raw:string)=>'sha256='+createHmac('sha256',secret).update(raw).digest('hex');
 const post=(p:unknown,signature?:string)=>{const raw=typeof p==='string'?p:JSON.stringify(p);return app.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json','x-hub-signature-256':signature ?? sign(raw)},payload:raw});};
 const deliver=(p:unknown)=>{const raw=JSON.stringify(p);return new WhatsAppWebhook(db,secret,clock,ownership).receive(Buffer.from(raw),sign(raw));};
 const counts=async()=>({conversations:await db.conversation.count(),messages:await db.message.count(),inbound:await db.whatsAppInbound.count(),usage:await db.usageInbound.count(),windows:await db.usageWindow.count(),audit:await db.auditLog.count()});
 const outcome=async(p:unknown)=>{const raw=typeof p==='string'?p:JSON.stringify(p);return (await db.webhookEvent.findUniqueOrThrow({where:{provider_eventId:{provider:'META_WHATSAPP',eventId:bodyDigest(raw)}}})).rawBody as {outcomes:Record<string,number>};};
 await t.test('GET subscription handshake returns exact challenge; wrong token, mode and query are safely rejected',async()=>{
  const valid=await app.inject({url:`/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=0012345`});assert.equal(valid.statusCode,200);assert.equal(valid.body,'0012345');assert.match(valid.headers['content-type']!,/text\/plain/);
  for(const url of [`?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`,`?hub.mode=wrong&hub.verify_token=${token}&hub.challenge=1`,`?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1&extra=x`]){
   const r=await app.inject({url:'/api/webhooks/whatsapp'+url});assert.equal(r.statusCode,403);assert.ok(!r.body.includes(token));
  }
 });
 await t.test('missing/invalid signatures reject before payload parsing or persistence',async()=>{
  const before=await counts(),events=await db.webhookEvent.count();
  const missing=await app.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json'},payload:'{'});assert.equal(missing.statusCode,401);
  assert.equal((await post('{','sha256='+'0'.repeat(64))).statusCode,401);
  assert.deepEqual(await counts(),before);assert.equal(await db.webhookEvent.count(),events);
 });
 await t.test('signed original whitespace is accepted and tenant comes only from number mapping',async()=>{
  const p={...payload({...value([message({text:{body:'Hello guest@example.com phone +2348091234567 secret: synthetic-private'}})]),tenantId:b.auth.user.tenantId}),tenantId:b.auth.user.tenantId};
  const raw=JSON.stringify(p,null,2)+'\n';assert.equal((await post(raw)).statusCode,200);
  const row=await db.whatsAppInbound.findFirstOrThrow();assert.equal(row.tenantId,a.auth.user.tenantId);assert.equal(row.phoneNumberId,'2001');assert.equal(row.messageType,'text');
  const convo=await db.conversation.findUniqueOrThrow({where:{id:row.conversationId}});assert.equal(convo.guestPhone,'+2348091234567');assert.equal(convo.simulation,false);assert.equal(convo.handlingMode,'HUMAN');assert.equal(convo.guestName,null);
  const stored=await db.message.findUniqueOrThrow({where:{id:row.messageId}});for(const marker of ['guest@example.com','2348091234567','synthetic-private']) assert.ok(!stored.body.includes(marker));
  assert.equal((await post(JSON.stringify(p),sign(raw))).statusCode,401);
  assert.equal(await db.usageWindow.count({where:{mode:'PRODUCTION'}}),0);assert.equal(await db.usageEvent.count(),0);
 });
 await t.test('malformed JSON, envelope, timestamps and oversized messages fail without business writes',async()=>{
  const before=await counts();
  for(const p of ['{','null',{},payload(value([message({timestamp:'0'})])),payload(value([message({timestamp:'999999999999'})])),payload(value([message({text:{body:'a'.repeat(2001)}})]))]) {
   const r=await post(p);assert.equal(r.statusCode,400,r.body);assert.equal((await outcome(p)).outcomes.MALFORMED,1);
  }
  assert.deepEqual(await counts(),before);
  assert.equal((await post(' '.repeat(131073))).statusCode,413);
 });
 await t.test('signed invalid UTF-8 fails safely without message persistence',async()=>{
  const before=await counts();const raw=Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xff]),Buffer.from('"}')]);
  const signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  const result=await app.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json','x-hub-signature-256':signature},payload:raw});
  assert.equal(result.statusCode,400);assert.deepEqual(await counts(),before);
 });
 await t.test('statuses, unsupported media and both echo forms never create guest inquiries or usage',async()=>{
  const before=await counts();
  const samples=[{p:payload(value([message({type:'image',text:undefined})])),kind:'UNSUPPORTED'},
   {p:payload(value([message({is_echo:true})])),kind:'ECHO'},
   {p:payload({messages:[message()]},'smb_message_echoes'),kind:'ECHO'},
   {p:payload({messaging_product:'whatsapp',metadata:{phone_number_id:'2001'},statuses:[{id:'wamid.out',timestamp:String(Math.floor(now.getTime()/1000)),status:'delivered',recipient_id:'2348091234567'}]}),kind:'STATUS'}];
  for(const {p,kind} of samples){assert.equal((await post(p)).statusCode,200);assert.equal((await outcome(p)).outcomes[kind],1);}
  assert.deepEqual(await counts(),before);
 });
 await t.test('unknown/inactive numbers and business mismatches are quarantined without personal payload retention',async()=>{
  const inactive=await mapping().create({phoneNumberId:'2003',businessId:'1001'});assert.equal(inactive.isActive,false);
  const before=await counts();
  for(const [phone,business,kind] of [['9999','1001','UNKNOWN_NUMBER'],['2003','1001','INACTIVE_NUMBER'],['2001','9999','BUSINESS_MISMATCH']]){
   const p=payload(value([message()],phone), 'messages',business);assert.equal((await post(p)).statusCode,200);const result=await outcome(p);assert.equal(result.outcomes[kind!],1);assert.ok(!JSON.stringify(result).includes('2348091234567'));
  }assert.deepEqual(await counts(),before);
 });
 await t.test('duplicate and repackaged deliveries do not add messages or move the inactivity window',async()=>{
  const m=message(),p=payload(value([m]));await deliver(p);
  const before=await counts(),window=await db.usageWindow.findFirstOrThrow({where:{tenantId:a.auth.user.tenantId}});
  now=new Date(now.getTime()+3600000);await deliver(p);await deliver({...p,irrelevant:'different-envelope'});
  assert.deepEqual(await counts(),before);assert.equal((await db.usageWindow.findUniqueOrThrow({where:{id:window.id}})).expiresAt.getTime(),window.expiresAt.getTime());
  assert.equal((await outcome({...p,irrelevant:'different-envelope'})).outcomes.DUPLICATE,1);
 });
 await t.test('concurrent identical and repackaged message deliveries create one message and one usage receipt',async()=>{
  const before=await counts();
  for(let round=0;round<5;round++) {
   const m=message({from:`23480900011${String(round).padStart(2,'0')}`}),p=payload(value([m]));
   const results=await Promise.allSettled([deliver(p),deliver(p),deliver({...p,additional:'envelope'})]);
   assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));
  }
  const after=await counts();assert.equal(after.messages-before.messages,5);assert.equal(after.usage-before.usage,5);assert.equal(after.windows-before.windows,5);assert.equal(after.inbound-before.inbound,5);
 });
 await t.test('earlier processing clocks never shorten a window; exact expiry starts the next window',async()=>{
  const sender='2348097773333';await deliver(payload(value([message({from:sender})])));
  const window=await db.usageWindow.findFirstOrThrow({where:{tenantId:a.auth.user.tenantId,identityHash:identityDigest([identityDigest([a.auth.user.tenantId,'WHATSAPP',`+${sender}`]),'META_TEST'])}});
  const conversation=await db.conversation.findFirstOrThrow({where:{tenantId:a.auth.user.tenantId,guestPhone:`+${sender}`}});
  now=new Date(now.getTime()-1000);await deliver(payload(value([message({from:sender,timestamp:String(Math.floor(now.getTime()/1000)-864000)})])));
  assert.equal((await db.usageWindow.findUniqueOrThrow({where:{id:window.id}})).expiresAt.getTime(),window.expiresAt.getTime());
  assert.equal((await db.conversation.findUniqueOrThrow({where:{id:conversation.id}})).lastMessageAt!.getTime(),conversation.lastMessageAt!.getTime());
  now=new Date(window.expiresAt);await deliver(payload(value([message({from:sender})])));
  const windows=await db.usageWindow.findMany({where:{tenantId:a.auth.user.tenantId,identityHash:window.identityHash},orderBy:{startedAt:'asc'}});
  assert.equal(windows.length,2);assert.equal(windows[1]!.startedAt.getTime(),windows[0]!.expiresAt.getTime());
 });
 await t.test('same message ID with changed contents is quarantined and cannot overwrite history',async()=>{
  const m=message(),p=payload(value([m]));await deliver(p);const before=await counts();
  const changed=payload(value([{...m,text:{body:'Different content'}}]));await deliver(changed);
  assert.deepEqual(await counts(),before);assert.equal((await outcome(changed)).outcomes.MESSAGE_ID_CONFLICT,1);
 });
 await t.test('multiple numbers under one business and scoped IDs do not merge tenants or guest conversations',async()=>{
  const second=await mapping().create({phoneNumberId:'2004',businessId:'1001',isActive:true});assert.notEqual(second.id,first.id);
  const m=message({from:'2348090002222',id:'wamid.shared-scope'});
  await Promise.all(['2001','2002','2004'].map(phone=>deliver(payload(value([m],phone)))));
  const rows=await db.whatsAppInbound.findMany({where:{metaMessageId:m.id}});assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.conversationId)).size,3);
  assert.equal(rows.filter(r=>r.tenantId===a.auth.user.tenantId).length,2);
 });
 await t.test('tenant-scoped reads allow staff and reject foreign IDs; inbound cannot invoke simulation processing or AI mode',async()=>{
  const own=await db.whatsAppInbound.findFirstOrThrow({where:{tenantId:a.auth.user.tenantId}}),foreign=await db.whatsAppInbound.findFirstOrThrow({where:{tenantId:b.auth.user.tenantId}});
  for(const who of [a,manager,reception]){
   for(const suffix of ['', '/messages','/escalations']) {assert.equal((await req('GET',`/conversations/${own.conversationId}${suffix}`,who)).statusCode,200);assert.equal((await req('GET',`/conversations/${foreign.conversationId}${suffix}`,who)).statusCode,404);}
   const list=(await req('GET','/conversations',who)).json();assert.ok(!JSON.stringify(list).includes(foreign.conversationId));
   assert.equal((await req('PATCH',`/conversations/${own.conversationId}/handling`,who,{mode:'AI'})).statusCode,404);
  }
  const sent=await app.inject({method:'POST',url:`/api/simulations/conversations/${own.conversationId}/messages`,headers:{authorization:`Bearer ${a.token}`,'idempotency-key':'whatsapp-no-simulation'},payload:{text:'hello'}});assert.equal(sent.statusCode,404);assert.equal(calls,0);
 });
 await t.test('connection management checks roles and tenant scope and never returns credentials',async()=>{
  assert.equal((await req('POST','/whatsapp/connections',reception,{phoneNumberId:'2005',businessId:'1001'})).statusCode,403);
  assert.equal((await req('GET','/whatsapp/connections',reception)).statusCode,403);
  assert.equal((await req('PATCH',`/whatsapp/connections/${first.id}`,reception,{isActive:false})).statusCode,403);
  assert.equal((await req('PATCH',`/whatsapp/connections/${other.id}`,manager,{isActive:false})).statusCode,404);
  assert.equal((await req('PATCH',`/whatsapp/connections/${first.id}`,manager,{displayName:'Pilot number'})).statusCode,200);
  assert.equal((await req('POST','/whatsapp/connections',manager,{phoneNumberId:'2005',businessId:'1001'})).statusCode,201);
  assert.equal((await req('POST','/whatsapp/connections',a,{phoneNumberId:'2001',businessId:'1001'})).statusCode,409);
  assert.equal((await req('POST','/whatsapp/connections',b,{phoneNumberId:'2001',businessId:'1001'})).statusCode,409);
  for(const patch of [{tenantId:b.auth.user.tenantId},{phoneNumberId:'9999'},{encryptedCredential:'synthetic-hidden'}]) assert.equal((await req('PATCH',`/whatsapp/connections/${first.id}`,a,patch)).statusCode,400);
  await db.channelConnection.update({where:{id:first.id},data:{encryptedCredential:'synthetic-private-database-credential'}});
  const result=await req('GET','/whatsapp/connections');assert.ok(!result.body.includes('synthetic-private'));assert.ok(!result.body.includes('encryptedCredential'));
  const audit=await db.auditLog.findFirstOrThrow({where:{action:'whatsapp.connection_updated',entityId:first.id,actorId:manager.auth.user.id}});assert.equal(audit.tenantId,a.auth.user.tenantId);assert.equal(audit.actorId,manager.auth.user.id);
 });
 await t.test('audit failure rolls back messages, usage and conversations; durable RETRY succeeds on redelivery',async()=>{
  await db.$executeRawUnsafe(`CREATE FUNCTION fixture_fail_whatsapp_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='whatsapp.message_received' THEN RAISE EXCEPTION 'synthetic-private-error'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fixture_fail_whatsapp_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fixture_fail_whatsapp_audit()');
  const p=payload(value([message({from:'2348095556666',timestamp:String(Math.floor(Date.now()/1000))})]));const before=await counts();
  try {const r=await post(p);assert.equal(r.statusCode,503);assert.ok(!r.body.includes('synthetic-private'));assert.deepEqual(await counts(),before);
   const row=await db.webhookEvent.findUniqueOrThrow({where:{provider_eventId:{provider:'META_WHATSAPP',eventId:bodyDigest(JSON.stringify(p))}}});assert.equal(row.status,'RETRY');assert.equal(row.lastError,'DATABASE_PROCESSING_FAILED');
  } finally {await db.$executeRawUnsafe('DROP TRIGGER fixture_fail_whatsapp_audit ON "AuditLog"');await db.$executeRawUnsafe('DROP FUNCTION fixture_fail_whatsapp_audit()');}
  assert.equal((await post(p)).statusCode,200);assert.equal((await counts()).messages-before.messages,1);
 });
 await t.test('batch failure leaves no partial messages and retry records the entire batch exactly once',async()=>{
  await db.$executeRawUnsafe(`CREATE FUNCTION fixture_fail_whatsapp_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='Fail batch fixture' THEN RAISE EXCEPTION 'synthetic batch failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fixture_fail_whatsapp_message BEFORE INSERT ON "Message" FOR EACH ROW EXECUTE FUNCTION fixture_fail_whatsapp_message()');
  const p=payload(value([message({from:'2348095557777'}),message({from:'2348095558888',text:{body:'Fail batch fixture'}})]));const before=await counts();
  try{await assert.rejects(deliver(p),/WEBHOOK_RETRY_REQUIRED/);assert.deepEqual(await counts(),before);}finally{await db.$executeRawUnsafe('DROP TRIGGER fixture_fail_whatsapp_message ON "Message"');await db.$executeRawUnsafe('DROP FUNCTION fixture_fail_whatsapp_message()');}
  await deliver(p);assert.equal((await counts()).messages-before.messages,2);const after=await counts();await deliver(p);assert.deepEqual(await counts(),after);
 });
 await t.test('Meta test channels remain identifiable and non-billable without consuming simulation or production allowances',async()=>{
  const c=await actor('OWNER');await mapping(c).create({phoneNumberId:'2006',businessId:'1001',isActive:true});
  await deliver(payload(value([message()], '2006')));
  assert.equal(await db.usageWindow.count({where:{tenantId:c.auth.user.tenantId,source:'META_TEST'}}),1);
  assert.equal(await db.usageWindow.count({where:{tenantId:c.auth.user.tenantId,mode:'PRODUCTION'}}),0);
  assert.equal((await db.usageInbound.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}})).status,'ACCEPTED');
  assert.equal((await db.whatsAppInbound.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}})).usageStatus,'ACCEPTED');
  assert.equal((await db.usageInbound.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}})).source,'META_TEST');
  await db.usagePolicy.update({where:{tenantId_mode:{tenantId:a.auth.user.tenantId,mode:'SIMULATION'}},data:{conversationAllowance:0}});
  const before=await db.usageWindow.count();await deliver(payload(value([message({from:'2348099994444'})])));assert.equal(await db.usageWindow.count(),before+1);
  assert.equal((await new UsageService(db,a.auth).summary('SIMULATION')).conversations,0);
 });
 await t.test('missing configuration and unavailable database never return false success; health remains live',async()=>{
  const missing=new URL(databaseUrl);missing.pathname='/absent_phase6b_fixture';missing.searchParams.set('connect_timeout','1');
  const offline=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:missing.toString(),META_WEBHOOK_ENABLED:'true',META_APP_SECRET:secret,META_VERIFY_TOKEN:token}),{logger:false});
  const disabled=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl}),{logger:false});
  try {
   assert.equal((await offline.inject('/api/health')).statusCode,200);assert.equal((await offline.inject('/api/ready')).statusCode,503);
   const raw=JSON.stringify(payload(value([message({timestamp:String(Math.floor(Date.now()/1000))})])));
   const response=await offline.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json','x-hub-signature-256':sign(raw)},payload:raw});
   assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{error:'WEBHOOK_RETRY_REQUIRED'});
   assert.equal((await disabled.inject('/api/webhooks/whatsapp')).statusCode,503);
   assert.equal((await disabled.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json'},payload:'{}'})).statusCode,503);
  } finally {await offline.close();await disabled.close();}
 });
 await t.test('processing across Lagos month boundary puts receipts and test windows in the same accounting period',async()=>{
  const c=await actor('OWNER');await mapping(c).create({phoneNumberId:'2007',businessId:'1001',isActive:true});
  const received=new Date('2030-01-31T22:59:59Z'),processed=new Date('2030-01-31T23:00:01Z');let reads=0;
  const p=payload(value([message({timestamp:String(received.getTime()/1000)})],'2007')),raw=JSON.stringify(p);
  await new WhatsAppWebhook(db,secret,()=>reads++===0 ? received:processed,ownership).receive(Buffer.from(raw),sign(raw));
  const window=await db.usageWindow.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}});
  const receipt=await db.usageInbound.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}});
  assert.equal(receipt.receivedAt.toISOString(),processed.toISOString());assert.equal(window.periodStart.toISOString(),'2030-01-31T23:00:00.000Z');
  assert.equal((await db.whatsAppInbound.findFirstOrThrow({where:{tenantId:c.auth.user.tenantId}})).receivedAt.toISOString(),received.toISOString());
 });
 await t.test('SQL uniqueness, immutable mapping ownership and composite child references reject cross-tenant writes',async()=>{
  await assert.rejects(db.channelConnection.update({where:{id:first.id},data:{tenantId:b.auth.user.tenantId}}),/WhatsApp_connection_identity_immutable/);
  await assert.rejects(db.channelConnection.create({data:{tenantId:b.auth.user.tenantId,channel:'WHATSAPP',externalBusinessId:'1009',externalPhoneNumberId:'2001'}}));
  await assert.rejects(db.channelConnection.create({data:{tenantId:a.auth.user.tenantId,channel:'WHATSAPP',externalBusinessId:'1008',isActive:true,whatsappState:'ACTIVE',whatsappEnvironment:'META_TEST',lastVerifiedAt:new Date(),verificationExpiresAt:new Date('2100-01-01'),credentialDigest:'a'.repeat(64)}}),/ChannelConnection_whatsapp_values/);
  const row=await db.whatsAppInbound.findFirstOrThrow({where:{tenantId:a.auth.user.tenantId}});
  await assert.rejects(db.whatsAppInbound.create({data:{...row,id:undefined,tenantId:b.auth.user.tenantId,metaMessageId:'wamid.foreign'}}));
  assert.equal(await db.message.count({where:{direction:'OUT'}}),0);assert.equal(await db.conversationTurn.count(),0);assert.equal(await db.usageEvent.count(),0);assert.equal(calls,0);
 });
});
