import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { matchesToken, normalizeMetaPayload, verifyMetaSignature } from '../src/services/whatsapp-validation.js';
const secret='synthetic-meta-app-secret-fixture';
const now=new Date('2030-01-01T00:00:00Z');
const message=(patch={})=>({from:'2348091234567',id:'wamid.fixture',timestamp:String(now.getTime()/1000),type:'text',text:{body:'Hello'},...patch});
const payload=(messages=[message()])=>({object:'whatsapp_business_account',entry:[{id:'1001',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'2001'},messages}}]}]});
test('Meta HMAC authenticates exact bytes including whitespace and safely rejects malformed headers',()=>{
 const raw=Buffer.from('{ "field": 1 }\n');const signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
 verifyMetaSignature(raw,signature,secret);
 for(const header of [undefined,'',signature.slice(0,-1),signature+'0',['a','b'],'sha256='+'0'.repeat(64)]) assert.throws(()=>verifyMetaSignature(raw,header,secret),/INVALID_WEBHOOK_SIGNATURE/);
 assert.throws(()=>verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))),signature,secret));
 assert.equal(matchesToken('same','same'),true);assert.equal(matchesToken('short','different-longer'),false);
});
test('Meta normalization keeps IDs, UTC timestamps and redacted text without inferring guest details',()=>{
 const result=normalizeMetaPayload(payload([message({text:{body:'My name is Jane Doe and email is guest@example.com. Phone +2348091234567 secret: synthetic-sensitive'}})]),now)[0]!;
 assert.equal(result.kind,'TEXT');if(result.kind!=='TEXT') return;
 assert.equal(result.phone,'+2348091234567');assert.equal(result.metaMessageId,'wamid.fixture');assert.equal(result.eventAt.toISOString(),now.toISOString());
 for(const value of ['Jane Doe','guest@example.com','2348091234567','synthetic-sensitive']) assert.ok(!result.text.includes(value));
 assert.match(result.inputHash,/^[a-f0-9]{64}$/);
});
test('Meta timestamps and message sizes are bounded, while delayed delivery remains valid',()=>{
 for(const timestamp of ['NaN','-1','0','999999999999',String(now.getTime()/1000+301)]) assert.throws(()=>normalizeMetaPayload(payload([message({timestamp})]),now));
 for(const body of ['', ' ', 'a'.repeat(2001)]) assert.throws(()=>normalizeMetaPayload(payload([message({text:{body}})]),now));
 assert.equal(normalizeMetaPayload(payload([message({text:{body:'a'.repeat(2000)},timestamp:String(now.getTime()/1000-864000)})]),now).length,1);
 assert.throws(()=>normalizeMetaPayload(payload([message({from:'not-a-phone'})]),now));
});
test('unsupported messages, delivery statuses and echoes are explicit non-inquiry outcomes',()=>{
 assert.equal(normalizeMetaPayload(payload([message({type:'image',text:undefined})]),now)[0]!.kind,'UNSUPPORTED');
 assert.equal(normalizeMetaPayload(payload([message({is_echo:true})]),now)[0]!.kind,'ECHO');
 const echo={object:'whatsapp_business_account',entry:[{id:'1001',changes:[{field:'smb_message_echoes',value:{messages:[message()]}}]}]};
 assert.equal(normalizeMetaPayload(echo,now)[0]!.kind,'ECHO');
 const status={object:'whatsapp_business_account',entry:[{id:'1001',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'2001'},statuses:[{id:'wamid.sent',timestamp:String(now.getTime()/1000),status:'delivered',recipient_id:'2348091234567'}]}}]}]};
 assert.equal(normalizeMetaPayload(status,now)[0]!.kind,'STATUS');
});
test('webhook enablement fails closed and cannot enable Paystack or a real AI provider',()=>{
 const base={DATABASE_URL:'postgresql://fixture@127.0.0.1/unused',META_WEBHOOK_ENABLED:'true',META_APP_SECRET:secret,META_VERIFY_TOKEN:'synthetic-verify-token-fixture-00001'};
 assert.equal(loadConfig(base).META_WEBHOOK_ENABLED,true);
 assert.throws(()=>loadConfig({...base,META_APP_SECRET:undefined}),/META_WEBHOOK_ENABLED/);
 assert.throws(()=>loadConfig({...base,META_VERIFY_TOKEN:'short'}),/META_VERIFY_TOKEN/);
 assert.throws(()=>loadConfig({...base,AI_PROVIDER:'openai',AI_MODEL:'fixture',OPENAI_API_KEY:'synthetic-fixture-key'}),/META_WEBHOOK_ENABLED/);
 assert.throws(()=>loadConfig({...base,PAYSTACK_TEST_ENABLED:'true',PAYSTACK_TEST_SECRET_KEY:'sk_test_syntheticfixture'}),/META_WEBHOOK_ENABLED/);
 assert.equal(loadConfig({DATABASE_URL:base.DATABASE_URL,NODE_ENV:'production'}).META_WEBHOOK_ENABLED,false);
});
test('request logs omit verification query strings, secrets and invalid inbound bodies',()=>{
 const script=`import {buildApp} from './src/app.ts'; import {loadConfig} from './src/config.ts';
 const app=await buildApp(loadConfig({DATABASE_URL:'postgresql://fixture@127.0.0.1:1/unused',NODE_ENV:'test',META_WEBHOOK_ENABLED:'true',META_APP_SECRET:'${secret}',META_VERIFY_TOKEN:'synthetic-verify-token-fixture-00001'}));
 await app.inject({url:'/api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=synthetic-verify-token-fixture-00001'});
 await app.inject({method:'POST',url:'/api/webhooks/whatsapp',headers:{'content-type':'application/json','x-hub-signature-256':'secret-signature-marker'},payload:'raw-guest-sensitive-marker'});await app.close();`;
 const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,AI_PROVIDER:'mock',PAYSTACK_TEST_ENABLED:'false'}});
 assert.match(output,/incoming request/);
 for(const marker of [secret,'synthetic-verify-token-fixture-00001','raw-guest-sensitive-marker','secret-signature-marker','hub.verify_token']) assert.ok(!output.includes(marker),marker);
});
