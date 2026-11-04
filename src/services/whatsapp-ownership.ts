import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { identityDigest, metaId } from './whatsapp-validation.js';

export type WhatsAppEnvironment = 'META_TEST' | 'META_PRODUCTION';
export type ConnectionIdentity = { tenantId:string; externalBusinessId:string; externalPhoneNumberId:string|null };
export type OwnershipProof = { environment:WhatsAppEnvironment; credentialDigest:string; expiresAt:Date };
export interface WhatsAppOwnership {
  verify(connection:ConnectionIdentity):Promise<OwnershipProof>;
  current(connection:ConnectionIdentity,proof:OwnershipProof):Promise<boolean>;
}
export interface WhatsAppActivationPolicy { allowsProduction(connection:ConnectionIdentity):boolean }
// There is deliberately no production activation environment flag or tenant API.
export const productionDisabled: WhatsAppActivationPolicy = {allowsProduction:()=>false};
export const ownershipUnavailable: WhatsAppOwnership = {
  async verify(){throw new HttpError(503,'META_OWNERSHIP_UNAVAILABLE');},async current(){return false;}
};
const grantSchema=z.strictObject({ tenantId:z.string().min(1).max(128), businessId:metaId, phoneNumberId:metaId,
  environment:z.enum(['META_TEST','META_PRODUCTION']), accessToken:z.string().regex(/^[A-Za-z0-9._|-]{16,4096}$/) });
const grantsSchema=z.array(grantSchema).min(1).max(100);
type Grant=z.infer<typeof grantSchema>;
/** Server-managed, owner-only secret mount outside the source tree. No tenant upload route. */
export class MetaCredentialStore {
  constructor(private readonly path?:string,private readonly repositoryRoot=process.cwd()) {}
  async get(connection:ConnectionIdentity):Promise<Grant> {
    let handle;
    try {
      if(!this.path || !isAbsolute(this.path)) throw new Error();
      const canonical=await realpath(this.path), local=relative(await realpath(resolve(this.repositoryRoot)),canonical);
      if(!local.startsWith('..'+(process.platform==='win32'?'\\':'/')) && local!=='..') throw new Error();
      handle=await open(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await handle.stat();
      if(!stat.isFile() || stat.size>65536 || (stat.mode & 0o077)!==0 || (process.getuid && stat.uid!==process.getuid())) throw new Error();
      const grants=grantsSchema.parse(JSON.parse(await handle.readFile('utf8')));
      // Duplicate asset grants are ambiguous, even if the requesting tenant matches one.
      if(new Set(grants.map(g=>g.phoneNumberId)).size!==grants.length) throw new Error();
      const grant=grants.find(g=>g.tenantId===connection.tenantId && g.businessId===connection.externalBusinessId && g.phoneNumberId===connection.externalPhoneNumberId);
      if(!grant) throw new Error();return grant;
    } catch {throw new HttpError(503,'META_OWNERSHIP_UNAVAILABLE');}
    finally {await handle?.close();}
  }
}
const debugSchema=z.object({data:z.object({is_valid:z.literal(true),app_id:metaId,scopes:z.array(z.string()),
  expires_at:z.number().int().nonnegative(),data_access_expires_at:z.number().int().nonnegative(),
  granular_scopes:z.array(z.object({scope:z.string(),target_ids:z.array(metaId).optional()})).optional()})});
const phonePage=z.object({data:z.array(z.object({id:metaId})).max(100),paging:z.object({next:z.string().optional(),
  cursors:z.object({after:z.string().min(1).max(2048)}).optional()}).optional()});
/** Read-only official Graph API checks. Provider errors/URLs/response bodies never leave this adapter. */
export class GraphWhatsAppOwnership implements WhatsAppOwnership {
  constructor(private readonly store:MetaCredentialStore,private readonly config:{appId?:string;appSecret?:string;version?:string},
    private readonly fetcher:typeof fetch=fetch,private readonly clock=()=>new Date()) {}
  private digest(grant:Grant) {return identityDigest([this.config.appId,grant]);}
  async current(connection:ConnectionIdentity,proof:OwnershipProof) {
    if(!this.config.appId || !this.config.appSecret || !this.config.version) return false;
    try {const grant=await this.store.get(connection);return proof.expiresAt>this.clock() && proof.environment===grant.environment && proof.credentialDigest===this.digest(grant);}
    catch{return false;}
  }
  async verify(connection:ConnectionIdentity):Promise<OwnershipProof> {
    const {appId,appSecret,version}=this.config;
    if(!appId || !appSecret || !version) throw new HttpError(503,'META_OWNERSHIP_UNAVAILABLE');
    const grant=await this.store.get(connection);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    const request=async(path:string,params:Record<string,string>,authorization:string)=>{
      const url=new URL(`https://graph.facebook.com/${version}/${path}`);
      for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
      const response=await this.fetcher(url,{method:'GET',headers:{authorization:`Bearer ${authorization}`},redirect:'error',signal:controller.signal});
      if(!response.ok || !response.body) throw new Error();
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try {while(true){const part=await reader.read();if(part.done) break;size+=part.value.byteLength;if(size>65536) throw new Error();chunks.push(part.value);}}
      finally {await reader.cancel();reader.releaseLock();}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    };
    try {
      const info=debugSchema.parse(await request('debug_token',{input_token:grant.accessToken},`${appId}|${appSecret}`)).data;
      const now=this.clock(),seconds=Math.floor(now.getTime()/1000);
      if(info.app_id!==appId || !info.scopes.includes('whatsapp_business_management') ||
        [info.expires_at,info.data_access_expires_at].some(expiry=>expiry!==0 && expiry<=seconds)) throw new Error();
      const granular=info.granular_scopes?.filter(s=>s.scope==='whatsapp_business_management');
      if(granular?.length && !granular.some(s=>!s.target_ids || s.target_ids.includes(grant.businessId))) throw new Error();
      const proof=createHmac('sha256',appSecret).update(grant.accessToken).digest('hex');
      const waba=z.object({id:metaId}).parse(await request(grant.businessId,{fields:'id',appsecret_proof:proof},grant.accessToken));
      if(waba.id!==grant.businessId) throw new Error();
      let after:string|undefined;let found=false;const cursors=new Set<string>();
      for(let page=0;page<10;page++) {
        const data=phonePage.parse(await request(`${grant.businessId}/phone_numbers`,{fields:'id',limit:'100',appsecret_proof:proof,...(after?{after}:{})},grant.accessToken));
        if(data.data.some(p=>p.id===grant.phoneNumberId)){found=true;break;}
        if(!data.paging?.next) break;
        // Never follow provider-supplied URLs: only bounded cursors on the fixed Graph origin.
        after=data.paging.cursors?.after;if(!after || cursors.has(after)) throw new Error();cursors.add(after);
      }
      if(!found) throw new Error();
      const expiry=Math.min(now.getTime()+24*3600000,...[info.expires_at,info.data_access_expires_at].filter(Boolean).map(n=>n*1000));
      const result={environment:grant.environment,credentialDigest:this.digest(grant),expiresAt:new Date(expiry)};
      if(!await this.current(connection,result)) throw new Error();return result;
    } catch {throw new HttpError(503,'META_OWNERSHIP_VERIFICATION_FAILED');}
    finally {clearTimeout(timer);}
  }
}
