import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphWhatsAppOwnership, MetaCredentialStore } from '../src/services/whatsapp-ownership.js';

const connection={tenantId:'tenant-a',externalBusinessId:'1001',externalPhoneNumberId:'2001'};
const grant={tenantId:'tenant-a',businessId:'1001',phoneNumberId:'2001',environment:'META_TEST',accessToken:'synthetic-token-not-a-real-secret'};
const config={appId:'3001',appSecret:'synthetic-app-secret',version:'v23.0'};
const now=new Date('2030-01-01T00:00:00Z');
const valid={data:{is_valid:true,app_id:'3001',scopes:['whatsapp_business_management'],expires_at:0,data_access_expires_at:0,
 granular_scopes:[{scope:'whatsapp_business_management',target_ids:['1001']}]}};

test('Graph ownership requires a protected server tenant grant and authorized matching assets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'meta-proof-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'credentials.json');await writeFile(path,JSON.stringify([grant]),{mode:0o600});
 const store=new MetaCredentialStore(path);
 let replies:unknown[]=[];const calls:Array<{url:URL;options:RequestInit|undefined}>=[];
 const fetcher:typeof fetch=async(input,options)=>{calls.push({url:new URL(String(input)),options});return Response.json(replies.shift());};
 const verifier=new GraphWhatsAppOwnership(store,config,fetcher,()=>now);
 const reset=()=>{calls.length=0;replies=[valid,{id:'1001'},{data:[{id:'2001'}]}];};
 await t.test('valid token, WABA and exact number produce a bounded proof; no provider URL is followed',async()=>{
  reset();replies=[valid,{id:'1001'},{data:[],paging:{next:'https://untrusted.invalid/?secret=x',cursors:{after:'next'}}},{data:[{id:'2001'}]}];
  const proof=await verifier.verify(connection);assert.equal(proof.environment,'META_TEST');assert.equal(proof.expiresAt.toISOString(),'2030-01-02T00:00:00.000Z');
  assert.match(proof.credentialDigest,/^[a-f0-9]{64}$/);assert.ok(await verifier.current(connection,proof));
  for(const missing of [{...config,appId:undefined},{...config,appSecret:undefined},{...config,version:undefined}]) assert.equal(await new GraphWhatsAppOwnership(store,missing,fetcher,()=>now).current(connection,proof),false);
  assert.equal(calls.length,4);assert.ok(calls.every(c=>c.url.origin==='https://graph.facebook.com' && c.options?.redirect==='error'));
  assert.equal(calls[0]!.url.pathname,'/v23.0/debug_token');assert.equal(calls[3]!.url.searchParams.get('after'),'next');
  assert.equal(calls[2]!.url.pathname,'/v23.0/1001/phone_numbers');assert.ok(!JSON.stringify(proof).includes(grant.accessToken));
  await writeFile(path,JSON.stringify([{...grant,accessToken:'rotated-synthetic-token'}]));assert.equal(await verifier.current(connection,proof),false);
  await writeFile(path,JSON.stringify([grant]));assert.equal(await verifier.current(connection,{...proof,expiresAt:now}),false);
 });
 await t.test('tenant, WABA and phone mismatches cannot borrow a different server grant',async()=>{
  for(const identity of [{...connection,tenantId:'tenant-b'},{...connection,externalBusinessId:'9999'},{...connection,externalPhoneNumberId:'9999'}]){
   reset();await assert.rejects(verifier.verify(identity),/META_OWNERSHIP_UNAVAILABLE/);assert.equal(calls.length,0);
  }
 });
 await t.test('failed token authorization, application, scope, expiry and asset checks fail safely',async()=>{
  const bad=[{...valid.data,is_valid:false},{...valid.data,app_id:'3999'},{...valid.data,scopes:[]},
   {...valid.data,expires_at:Math.floor(now.getTime()/1000)},{...valid.data,data_access_expires_at:1},
   {...valid.data,granular_scopes:[{scope:'whatsapp_business_management',target_ids:['9999']}]}];
  for(const data of bad){reset();replies[0]={data};await assert.rejects(verifier.verify(connection),/META_OWNERSHIP_VERIFICATION_FAILED/);}
  reset();replies[1]={id:'9999'};await assert.rejects(verifier.verify(connection),/META_OWNERSHIP_VERIFICATION_FAILED/);
  reset();replies[2]={data:[{id:'9999'}]};await assert.rejects(verifier.verify(connection),/META_OWNERSHIP_VERIFICATION_FAILED/);
  reset();replies[0]={data:{...valid.data,expires_at:Math.floor(now.getTime()/1000)+60}};
  assert.equal((await verifier.verify(connection)).expiresAt.getTime(),now.getTime()+60000);
 });
 await t.test('missing configuration, provider errors and oversized responses never expose credentials',async()=>{
  await assert.rejects(new GraphWhatsAppOwnership(store,{}).verify(connection),/META_OWNERSHIP_UNAVAILABLE/);
  for(const fail of [async()=>{throw new Error(grant.accessToken+config.appSecret);},async()=>Response.json({error:grant.accessToken},{status:401}),
   async()=>new Response('x'.repeat(65537)),async()=>new Response('{invalid')]){
   const adapter=new GraphWhatsAppOwnership(store,config,fail,()=>now);
   await assert.rejects(adapter.verify(connection),(e:Error)=>{assert.equal(e.message,'META_OWNERSHIP_VERIFICATION_FAILED');assert.ok(!e.stack?.includes(grant.accessToken));return true;});
  }
 });
 await t.test('secret store rejects unsafe permissions, source-tree paths, symlinks, duplicate grants and malformed files',async()=>{
  await chmod(path,0o644);await assert.rejects(store.get(connection),/META_OWNERSHIP_UNAVAILABLE/);await chmod(path,0o600);
  await assert.rejects(new MetaCredentialStore(path,dir).get(connection),/META_OWNERSHIP_UNAVAILABLE/);
  const link=join(dir,'link');await symlink(path,link);await assert.rejects(new MetaCredentialStore(link).get(connection),/META_OWNERSHIP_UNAVAILABLE/);
  for(const text of ['{',JSON.stringify([grant,grant]),JSON.stringify([{...grant,environment:'INTERNAL_SIMULATION'}])]){
   await writeFile(path,text);await assert.rejects(store.get(connection),/META_OWNERSHIP_UNAVAILABLE/);
  }
  await assert.rejects(new MetaCredentialStore().get(connection),/META_OWNERSHIP_UNAVAILABLE/);
  await assert.rejects(new MetaCredentialStore(join(dir,'missing')).get(connection),/META_OWNERSHIP_UNAVAILABLE/);
 });
});
