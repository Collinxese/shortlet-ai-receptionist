import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { publicUserSelect, type AuthContext } from '../../src/services/authentication.js';
import { UsageService, usageInputHash } from '../../src/services/usage-service.js';
import { ConversationService } from '../../src/services/conversation-service.js';
import { MockConversationModel } from '../../src/services/conversation-model.js';
import { usagePeriod } from '../../src/services/usage-validation.js';
import { plan } from '../../src/services/conversation-validation.js';
import { isolatedDatabase } from './database.js';

test('Phase 6A usage ledger, caps, counting, failure recovery and privacy on PostgreSQL', async(t) => {
  const {db,databaseUrl,deploy}=await isolatedDatabase(t); deploy();
  let sequence=0;
  const app=await buildApp(loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl}),{db,logger:false});t.after(()=>app.close());
  const actor=async(name:string,role: 'OWNER'|'MANAGER'|'RECEPTIONIST'='OWNER',tenantId?:string) => {
    const tenant=tenantId ? {id:tenantId} : await db.tenant.create({data:{name}});
    const user=await db.user.create({data:{tenantId:tenant.id,email:`${name}@example.com`,name,role,passwordHash:'test-only'},select:publicUserSelect});
    return {user,sessionId:'test-only'} satisfies AuthContext;
  };
  const a=await actor('usage-owner-a'),b=await actor('usage-owner-b');
  const receptionist=await actor('usage-reception','RECEPTIONIST',a.user.tenantId),manager=await actor('usage-manager','MANAGER',a.user.tenantId);
  const policy=(patch={})=>({plan:'STARTER',conversationAllowance:300,monthlyCapMicroUsd:'1000000',minimumReservationMicroUsd:'1',maxRequestMicroUsd:'100000',maxInputBytes:16000,maxOutputTokens:1500,maxCallsPerTurn:2,maxRetries:1,...patch});
  let now=new Date('2030-01-10T12:00:00Z');const clock=()=>new Date(now);
  const service=(auth=a,defaults=true)=>new UsageService(db,auth,{developmentDefaults:defaults},clock);
  const svc=service(), other=service(b);
  const reserve=(s=svc,key=`usage-key-${++sequence}`,patch={})=>s.reserve({key,inputHash:usageInputHash('synthetic'),estimatedInputTokens:200,...patch});
  const nextPeriod=()=>{now=new Date(Date.UTC(2030,++sequence,10,12));};
  const conversation=async(auth=a)=>{
    const core=new ConversationService(db,auth,new MockConversationModel(),500,clock);
    return (await core.create({},`usage-conversation-${++sequence}`)).id;
  };
  await svc.summary('SIMULATION');await other.summary('SIMULATION');

  await t.test('reservation, completion and exact duplicate reconciliation; immutable price snapshots',async()=>{
    const {event}=await reserve();assert.equal(event.accountedMicroUsd,event.reservedMicroUsd);
    await svc.dispatch(event.id);
    const done=await svc.settle(event.id,{kind:'complete',inputTokens:100,outputTokens:50});
    assert.equal(done.actualMicroUsd,450n);assert.equal(done.accountedMicroUsd,450n);assert.ok(done.releasedAt);
    assert.equal((await svc.settle(event.id,{kind:'complete',inputTokens:100,outputTokens:50})).id,event.id);
    await assert.rejects(svc.settle(event.id,{kind:'complete',inputTokens:101,outputTokens:50}),/USAGE_ALREADY_SETTLED/);
    await assert.rejects(db.usageEvent.update({where:{id:event.id},data:{inputRateMicroUsd:0}}),/UsageEvent_immutable/);
    await assert.rejects(db.usageEvent.delete({where:{id:event.id}}),/UsageEvent_immutable/);
    const stored=await db.usageEvent.findUniqueOrThrow({where:{id:event.id}});assert.equal(stored.pricingVersion,'UNVERIFIED-TEST-USD-v1');
    assert.equal(await db.auditLog.count({where:{entityId:event.id,action:'usage.settled'}}),1);
  });
  await t.test('idempotent concurrent reservations return one record; materially changed input conflicts',async()=>{
    const key='usage-duplicate-reserve';const results=await Promise.all([reserve(svc,key),reserve(svc,key)]);
    assert.notEqual(results[0].event.key,key);assert.match(results[0].event.key,/^[a-f0-9]{64}$/);
    assert.equal(results[0].event.id,results[1].event.id);assert.equal(results.filter(r=>!r.replay).length,1);
    await assert.rejects(reserve(svc,key,{estimatedInputTokens:201}),/IDEMPOTENCY_CONFLICT/);
    await svc.settle(results[0].event.id,{kind:'release'});
    assert.equal((await reserve(svc,key)).event.status,'RELEASED');
  });
  await t.test('two instances cannot bypass tenant or global caps concurrently',async()=>{
    nextPeriod();await svc.configure('SIMULATION',policy({monthlyCapMicroUsd:'7900'}));
    const results=await Promise.allSettled([reserve(),reserve(new UsageService(db,a,{developmentDefaults:true},clock))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/TENANT_AI_CAP/);
    assert.equal((await svc.summary('SIMULATION')).accountedMicroUsd,'7900');
    assert.ok((await svc.alerts('SIMULATION',100)).some(r=>r.code==='TENANT_AI_WARNING' && r.threshold===100));
    nextPeriod();await svc.configure('SIMULATION',policy());
    await db.usageGlobalPolicy.update({where:{mode:'SIMULATION'},data:{monthlyCapMicroUsd:7900}});
    try {
      const competing=await Promise.allSettled([reserve(),reserve(other)]);
      assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
      assert.match(String((competing.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/GLOBAL_AI_CAP/);
    } finally {await db.usageGlobalPolicy.update({where:{mode:'SIMULATION'},data:{monthlyCapMicroUsd:100000000}});}
  });
  await t.test('release only undispatched work; unknown outcomes stay fully encumbered until reconciliation',async()=>{
    nextPeriod();const first=await reserve();await svc.dispatch(first.event.id);
    await assert.rejects(svc.settle(first.event.id,{kind:'release'}),/USAGE_OUTCOME_UNKNOWN/);
    const uncertain=await svc.settle(first.event.id,{kind:'unknown'});assert.equal(uncertain.accountedMicroUsd,first.event.reservedMicroUsd);
    assert.equal(uncertain.status,'REVIEW');assert.ok(uncertain.failedAt);
    const done=await svc.settle(first.event.id,{kind:'complete',inputTokens:10,outputTokens:10});assert.equal(done.accountedMicroUsd,70n);
    const pending=await reserve();now=new Date(now.getTime()+120001);await svc.recover();
    assert.equal((await svc.get(pending.event.id)).status,'RELEASED');
    const sent=await reserve();await svc.dispatch(sent.event.id);now=new Date(now.getTime()+120001);await svc.recover();
    assert.equal((await svc.get(sent.event.id)).status,'REVIEW');
    assert.equal((await svc.get(sent.event.id)).accountedMicroUsd,sent.event.reservedMicroUsd.toString());
  });
  await t.test('fixture simulations use versioned test prices and distinguish zero/unknown outcomes',async()=>{
    nextPeriod();const realFetch=globalThis.fetch;let calls=0;
    globalThis.fetch=async()=>{calls++;throw new Error('NETWORK_FORBIDDEN');};
    try {
      const complete=await svc.simulate({inputTokens:30,outputTokens:20},'fixture-complete');assert.equal(complete.actualMicroUsd,'160');
      const failed=await svc.simulate({inputTokens:30,outputTokens:20,outcome:'known_failure'},'fixture-failed');assert.equal(failed.status,'FAILED');assert.equal(failed.accountedMicroUsd,'0');
      const unknown=await svc.simulate({inputTokens:30,outputTokens:20,outcome:'unknown'},'fixture-unknown');assert.equal(unknown.status,'REVIEW');
      const replay=await svc.simulate({inputTokens:30,outputTokens:20,outcome:'unknown'},'fixture-unknown');assert.deepEqual(replay,unknown);
      await svc.reconcileSimulation(unknown.id,30,20);assert.equal((await svc.get(unknown.id)).actualMicroUsd,'160');
      assert.equal(calls,0);
    }finally{globalThis.fetch=realFetch;}
  });
  await t.test('eligible inbound dedup, normalized identity, inactivity and separate tenant windows',async()=>{
    nextPeriod();await svc.configure('SIMULATION',policy({conversationAllowance:1}));
    const input={phone:'08091234567',eventId:'inbound-unique-001'};
    const rows=await Promise.all([svc.recordInbound(input),svc.recordInbound(input)]);assert.equal(rows[0].id,rows[1].id);
    const window=await db.usageWindow.findUniqueOrThrow({where:{id:rows[0].windowId}});
    now=new Date(now.getTime()+3600000);const replay=await svc.recordInbound(input);assert.equal(replay.id,rows[0].id);
    assert.equal((await db.usageWindow.findUniqueOrThrow({where:{id:window.id}})).expiresAt.getTime(),window.expiresAt.getTime());
    const continued=await svc.recordInbound({phone:'+2348091234567',eventId:'inbound-unique-002'});assert.equal(continued.windowId,window.id);
    const foreign=await other.recordInbound(input);assert.notEqual(foreign.windowId,window.id);
    await assert.rejects(svc.recordInbound({...input,phone:'+2348091234568'}),/IDEMPOTENCY_CONFLICT/);
    const blocked=await svc.recordInbound({phone:'+2348091234568',eventId:'inbound-unique-003'});assert.equal(blocked.status,'BLOCKED');
    await svc.configure('SIMULATION',policy({conversationAllowance:0}));
    assert.equal((await svc.recordInbound({phone:input.phone,eventId:'inbound-existing-004'})).status,'ACCEPTED');
    now=new Date(now.getTime()+24*3600000);
    assert.equal((await svc.recordInbound({phone:input.phone,eventId:'inbound-expired-005'})).status,'BLOCKED');
    await svc.configure('SIMULATION',policy({conversationAllowance:2}));
    assert.equal((await svc.recordInbound({phone:input.phone,eventId:'inbound-plan-change'})).status,'ACCEPTED');
    assert.equal((await svc.summary('PRODUCTION')).conversations,0);
    assert.equal(JSON.stringify(await db.usageWindow.findMany()).includes('08091234567'),false);
  });
  await t.test('conversation allowance stays in start month; incurred calls use the new Lagos month',async()=>{
    now=new Date('2040-01-31T22:30:00Z');await svc.configure('SIMULATION',policy({conversationAllowance:1}));
    const first=await svc.recordInbound({phone:'+2348093334444',eventId:'period-first-inbound'});
    now=new Date('2040-02-01T00:30:00Z');
    const next=await svc.recordInbound({phone:'+2348093334444',eventId:'period-second-inbound'});assert.equal(next.windowId,first.windowId);
    assert.equal((await svc.summary('SIMULATION')).conversations,0);
    const event=await reserve();assert.equal(event.event.periodStart.toISOString(),'2040-01-31T23:00:00.000Z');
    const window=await db.usageWindow.findUniqueOrThrow({where:{id:first.windowId}});assert.equal(window.periodStart.toISOString(),'2039-12-31T23:00:00.000Z');
    assert.equal((await svc.recordInbound({phone:'+2348093334445',eventId:'new-period-start'})).status,'ACCEPTED');
  });
  await t.test('missing production config fails closed and cannot provision development financial defaults',async()=>{
    const fresh=await actor('usage-production-owner');const prod=service(fresh,false);
    await assert.rejects(reserve(prod),/USAGE_CONFIGURATION_MISSING/);
    assert.equal(await db.usagePolicy.count({where:{tenantId:fresh.user.tenantId}}),0);
    let calls=0;const blockedCore=new ConversationService(db,fresh,{name:'mock',async plan(){calls++;return plan('greet');}},500,clock,{developmentDefaults:false});
    const blockedConversation=await blockedCore.create({},'missing-cap-create');
    await blockedCore.send(blockedConversation.id,{text:'Hello'},'missing-cap-turn');assert.equal(calls,0);
    assert.equal(await db.usagePolicy.count({where:{tenantId:fresh.user.tenantId}}),0);
    await assert.rejects(prod.reserve({key:'production-reserve',inputHash:usageInputHash('fixture'),estimatedInputTokens:100},'PRODUCTION'),/USAGE_CONFIGURATION_MISSING/);
    const chat=await db.conversation.create({data:{tenantId:fresh.user.tenantId,channel:'WHATSAPP',externalId:'test-only-production',guestPhone:'+2348094445555'}});
    assert.equal((await prod.recordInbound({phone:chat.guestPhone!,eventId:'production-inbound',conversationId:chat.id},'PRODUCTION')).status,'BLOCKED');
    await prod.configure('PRODUCTION',policy({conversationAllowance:1}));
    assert.equal((await prod.recordInbound({phone:chat.guestPhone!,eventId:'production-inbound-2',conversationId:chat.id},'PRODUCTION')).status,'ACCEPTED');
    await db.usageGlobalPolicy.create({data:{mode:'PRODUCTION',monthlyCapMicroUsd:100000}});
    await assert.rejects(prod.reserve({key:'production-disabled',inputHash:usageInputHash('fixture'),estimatedInputTokens:100},'PRODUCTION'),/PRODUCTION_AI_DISABLED/);
  });
  await t.test('tenant scoped service methods and composite foreign keys reject foreign resources',async()=>{
    const foreignId=await conversation(b);await assert.rejects(reserve(svc,'foreign-usage-lookup',{conversationId:foreignId}),/NOT_FOUND/);
    const row=await reserve(other);await assert.rejects(svc.get(row.event.id),/NOT_FOUND/);await assert.rejects(svc.dispatch(row.event.id),/NOT_FOUND/);
    await assert.rejects(svc.reconcileSimulation(row.event.id,0,0),/NOT_FOUND/);
    await assert.rejects(service(receptionist).configure('SIMULATION',policy()),/FORBIDDEN/);await assert.rejects(service(receptionist).summary('SIMULATION'),/FORBIDDEN/);
    await service(manager).configure('SIMULATION',policy());
    await assert.rejects(db.usageEvent.create({data:{...row.event,id:undefined,tenantId:a.user.tenantId,conversationId:foreignId,key:'raw-cross-tenant',correlationId:'raw-foreign-test'}}),/Foreign key/);
    const audit=await db.auditLog.findFirstOrThrow({where:{entityId:row.event.id,action:'usage.reserved'}});assert.equal(audit.actorId,b.user.id);assert.equal(audit.tenantId,b.user.tenantId);
  });
  const failAudit=async(action:string)=>{
    await db.$executeRawUnsafe(`CREATE FUNCTION usage_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER usage_test_fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION usage_test_fail_audit()');
  };
  const clearAudit=async()=>{await db.$executeRawUnsafe('DROP TRIGGER usage_test_fail_audit ON "AuditLog"');await db.$executeRawUnsafe('DROP FUNCTION usage_test_fail_audit()');};
  await t.test('reservation/audit failure before dispatch never invokes the planner',async()=>{
    let calls=0;const core=new ConversationService(db,a,{name:'mock',async plan(){calls++;return plan('greet');}},500,clock);
    const policyBefore=await db.usagePolicy.findUniqueOrThrow({where:{tenantId_mode:{tenantId:a.user.tenantId,mode:'SIMULATION'}}});
    await failAudit('usage.policy_changed');
    try {await assert.rejects(svc.configure('SIMULATION',policy({monthlyCapMicroUsd:'0'})),/synthetic audit failure/);}finally{await clearAudit();}
    assert.deepEqual(await db.usagePolicy.findUniqueOrThrow({where:{tenantId_mode:{tenantId:a.user.tenantId,mode:'SIMULATION'}}}),policyBefore);
    const c=await core.create({},'ledger-failure-create');await failAudit('usage.reserved');
    try {const reply=await core.send(c.id,{text:'Hello'},'ledger-failure-turn');assert.equal((reply as {escalationRecorded:boolean}).escalationRecorded,true);}finally{await clearAudit();}
    assert.equal(calls,0);assert.equal(await db.usageEvent.count({where:{conversationId:c.id}}),0);
    assert.equal(await db.auditLog.count({where:{action:'usage.reserved',entityId:c.id}}),0);
  });
  await t.test('failed settlement keeps full reservation; successful turn replay never accounts twice',async()=>{
    let calls=0;const core=new ConversationService(db,a,{name:'mock',usageFixture:{inputTokens:100,outputTokens:50},async plan(){calls++;return plan('greet');}},500,clock);
    const c=await core.create({},'settlement-failure-create');await failAudit('usage.settled');
    try {await core.send(c.id,{text:'Hello'},'settlement-failure-turn');}finally{await clearAudit();}
    const event=await db.usageEvent.findFirstOrThrow({where:{conversationId:c.id}});assert.equal(event.status,'RESERVED');assert.equal(event.accountedMicroUsd,event.reservedMicroUsd);
    assert.equal(calls,1);await core.send(c.id,{text:'Hello'},'settlement-failure-turn');assert.equal(calls,1);
    const normal=await core.create({},'normal-ledger-create');const one=await core.send(normal.id,{text:'Hello'},'normal-ledger-turn');
    assert.deepEqual(await core.send(normal.id,{text:'Hello'},'normal-ledger-turn'),one);
    assert.equal(await db.usageEvent.count({where:{conversationId:normal.id}}),1);
    assert.equal(await db.usageWindow.count({where:{tenantId:a.user.tenantId,mode:'PRODUCTION'}}),0);
  });
  await t.test('mock failures, unknown results, cap fallback and live provider prohibition',async()=>{
    for(const outcome of ['known_failure','unknown'] as const){
      const core=new ConversationService(db,a,new MockConversationModel({inputTokens:10,outputTokens:10},outcome),500,clock);
      const c=await core.create({},`failure-create-${outcome}`);await core.send(c.id,{text:'Hello'},`failure-turn-${outcome}`);
      assert.equal((await db.usageEvent.findFirstOrThrow({where:{conversationId:c.id}})).status,outcome==='known_failure'?'FAILED':'REVIEW');
    }
    let calls=0;const core=new ConversationService(db,a,{name:'mock',async plan(){calls++;return plan('greet');}},500,clock);
    await svc.configure('SIMULATION',policy({monthlyCapMicroUsd:'0'}));
    const c=await core.create({},'cap-fallback-create');const reply=await core.send(c.id,{text:'Hello'},'cap-fallback-turn');assert.equal(calls,0);assert.equal((reply as {escalationRecorded:boolean}).escalationRecorded,true);
    await svc.configure('SIMULATION',policy());
    const forbidden=new ConversationService(db,a,{name:'openai',async plan(){calls++;throw new Error('NETWORK_FORBIDDEN');}},500,clock);
    const blocked=await forbidden.create({},'live-blocked-create');await forbidden.send(blocked.id,{text:'Hello'},'live-blocked-turn');assert.equal(calls,0);
  });
  await t.test('takeover and turn completion failure preserve accounting and do not extend billing windows',async()=>{
    nextPeriod();await svc.configure('SIMULATION',policy());
    const receipt=await svc.recordInbound({phone:'+2348098887777',eventId:'takeover-counting-inbound'});
    const before=await db.usageWindow.findUniqueOrThrow({where:{id:receipt.windowId}});
    let release!:()=>void,entered!:()=>void,calls=0;
    const started=new Promise<void>(r=>{entered=r;});
    const core=new ConversationService(db,a,{name:'mock',usageFixture:{inputTokens:100,outputTokens:50},async plan(){
      calls++;entered();await new Promise<void>(r=>{release=r;});return plan('greet');
    }},10000,clock);
    const c=await core.create({},'usage-takeover-create');const pending=core.send(c.id,{text:'Hello'},'usage-takeover-turn');
    await started;await core.handling(c.id,{mode:'HUMAN'});release();await pending;
    assert.equal(calls,1);assert.equal((await db.usageEvent.findFirstOrThrow({where:{conversationId:c.id}})).status,'COMPLETED');
    await core.send(c.id,{text:'Staff follow-up'},'usage-human-turn');assert.equal(calls,1);
    assert.deepEqual(await db.usageWindow.findUniqueOrThrow({where:{id:receipt.windowId}}),before);
    const normal=new ConversationService(db,a,{name:'mock',usageFixture:{inputTokens:100,outputTokens:50},async plan(){calls++;return plan('greet');}},500,clock);
    const d=await normal.create({},'usage-recovery-create');await failAudit('conversation.turn_completed');
    try {await assert.rejects(normal.send(d.id,{text:'Hello'},'usage-recovery-turn'),/synthetic audit failure/);}finally{await clearAudit();}
    const priorCalls=calls;now=new Date(now.getTime()+120001);
    await normal.send(d.id,{text:'Hello'},'usage-recovery-turn');assert.equal(calls,priorCalls);
    assert.equal(await db.usageEvent.count({where:{conversationId:d.id}}),1);
  });
  await t.test('input/output/request and per-turn retry bounds fail closed and retain conservative costs',async()=>{
    nextPeriod();await svc.configure('SIMULATION',policy({maxInputBytes:100,maxOutputTokens:10,maxRequestMicroUsd:'250',maxCallsPerTurn:1,maxRetries:0}));
    await assert.rejects(reserve(),/USAGE_INPUT_LIMIT/);
    const first=await reserve(svc,'bounded-request',{estimatedInputTokens:100});await svc.dispatch(first.event.id);
    await assert.rejects(svc.settle(first.event.id,{kind:'complete',inputTokens:100,outputTokens:11}),/USAGE_BOUND_EXCEEDED/);
    assert.equal((await svc.get(first.event.id)).accountedMicroUsd,'250');
    await svc.configure('SIMULATION',policy({maxRequestMicroUsd:'10'}));await assert.rejects(reserve(),/USAGE_REQUEST_LIMIT/);
    await svc.configure('SIMULATION',policy({maxCallsPerTurn:1,maxRetries:0}));
    const c=await conversation();
    const turn=await db.conversationTurn.create({data:{tenantId:a.user.tenantId,conversationId:c,key:'bound-turn-key',inputHash:usageInputHash('text'),leaseToken:'a'.repeat(32),leaseUntil:new Date(now.getTime()+120000),request:{message:'safe fixture'}}});
    await reserve(svc,'first-bound-attempt',{conversationId:c,turnId:turn.id});
    await assert.rejects(reserve(svc,'second-bound-attempt',{conversationId:c,turnId:turn.id}),/USAGE_TURN_LIMIT/);
    await svc.configure('SIMULATION',policy());
    now=new Date(usagePeriod(now).end.getTime()-60000);
    const old=await reserve();now=new Date(usagePeriod(now).end.getTime());
    await assert.rejects(svc.dispatch(old.event.id),/USAGE_PERIOD_CHANGED/);
  });
  await t.test('SQL window exclusion and receipt atomicity back up counting under competing inbound messages',async()=>{
    nextPeriod();await svc.configure('SIMULATION',policy({conversationAllowance:1}));
    const two=await Promise.all([svc.recordInbound({phone:'+2348097776666',eventId:'concurrent-inbound-a'}),
      svc.recordInbound({phone:'+2348097776666',eventId:'concurrent-inbound-b'})]);
    assert.equal(two[0].windowId,two[1].windowId);assert.equal((await svc.summary('SIMULATION')).conversations,1);
    const row=await db.usageWindow.findUniqueOrThrow({where:{id:two[0].windowId}});
    await assert.rejects(db.usageWindow.create({data:{...row,id:undefined}}),/UsageWindow_no_overlap/);
    assert.equal((await svc.recordInbound({phone:'+2348097776667',eventId:'concurrent-inbound-c'})).status,'BLOCKED');
  });
  await t.test('HTTP financial routes authorize roles, reject tenant spoofing and scope enumeration',async()=>{
    // Issue synthetic session digests directly; the real authentication middleware still validates them.
    const {createHash}=await import('node:crypto');
    const tokens=new Map<AuthContext,string>();
    for(const auth of [a,b,manager,receptionist]){
      const token=Buffer.alloc(32,++sequence%255).toString('base64url');tokens.set(auth,token);
      await db.authSession.create({data:{tenantId:auth.user.tenantId,userId:auth.user.id,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
    }
    const req=(method:'GET'|'POST'|'PUT',url:string,auth=a,payload?:object)=>app.inject({method,url:'/api'+url,headers:{authorization:`Bearer ${tokens.get(auth)}`,'idempotency-key':'http-fixture-key'},payload});
    assert.equal((await req('GET','/usage',receptionist)).statusCode,403);
    for (const url of ['/usage/events','/usage/alerts']) assert.equal((await req('GET',url,receptionist)).statusCode,403);
    for (const url of ['/usage/simulations','/usage/simulations/inbound','/usage/recover']) assert.equal((await req('POST',url,receptionist,{})).statusCode,403);
    assert.equal((await req('PUT','/usage/policy/SIMULATION',receptionist,policy())).statusCode,403);
    assert.equal((await req('PUT','/usage/policy/SIMULATION',manager,policy())).statusCode,200);
    assert.equal((await req('PUT','/usage/policy/SIMULATION',a,{...policy(),tenantId:b.user.tenantId})).statusCode,400);
    assert.equal((await req('PUT','/usage/policy/SIMULATION',a,policy({monthlyCapMicroUsd:'-1'}))).statusCode,400);
    const foreign=await reserve(other);
    assert.equal((await req('GET',`/usage/events/${foreign.event.id}`)).statusCode,404);
    assert.equal((await req('POST',`/usage/simulations/${foreign.event.id}/reconcile`,a,{inputTokens:0,outputTokens:0})).statusCode,404);
    const body=(await req('GET','/usage/events')).json();assert.ok(body.events.every((v:{tenantId:string})=>v.tenantId===a.user.tenantId));
    assert.equal((await req('POST','/usage/simulations',a,{inputTokens:10,outputTokens:5})).statusCode,200);
    assert.equal((await req('POST','/usage/simulations/inbound',a,{phone:'+2348099990000',eventId:'http-inbound-fixture'})).statusCode,200);
    assert.equal((await req('GET','/usage/alerts',manager)).statusCode,200);
  });
});
