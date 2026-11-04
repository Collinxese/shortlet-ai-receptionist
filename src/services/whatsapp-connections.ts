import { randomUUID } from 'node:crypto';
import { ownershipUnavailable, productionDisabled, type WhatsAppOwnership, type WhatsAppActivationPolicy, type WhatsAppEnvironment } from './whatsapp-ownership.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { hasPermission } from './authorization.js';
import { HttpError } from './errors.js';
import { connectionBody, connectionPatch } from './whatsapp-validation.js';
import { id } from './validation.js';
import { conversationListQuery } from './conversation-validation.js';

const select = { id:true, externalBusinessId:true, externalPhoneNumberId:true, displayName:true, isActive:true,
  whatsappState:true,whatsappEnvironment:true,lastVerifiedAt:true,verificationExpiresAt:true,createdAt:true, updatedAt:true } satisfies Prisma.ChannelConnectionSelect;
/** Only safe mapping fields are read or written. No credential transport or Embedded Signup. */
export class WhatsAppConnections {
  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext,private readonly ownership:WhatsAppOwnership=ownershipUnavailable,
    private readonly activation:WhatsAppActivationPolicy=productionDisabled,private readonly clock=()=>new Date()) {}
  private permit() { if (!hasPermission(this.auth.user.role,'whatsapp:manage')) throw new HttpError(403,'FORBIDDEN'); }
  async list(input: unknown) {
    this.permit(); const {limit,offset}=conversationListQuery.parse(input);
    return { connections: await this.db.channelConnection.findMany({where:{tenantId:this.auth.user.tenantId,channel:'WHATSAPP'},
      select,orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,skip:offset}), limit,offset };
  }
  async create(input: unknown) {
    this.permit(); const data=connectionBody.parse(input);
    try {
      return await this.db.$transaction(async tx => {
        const row=await tx.channelConnection.create({data:{tenantId:this.auth.user.tenantId,channel:'WHATSAPP',
          externalBusinessId:data.businessId,externalPhoneNumberId:data.phoneNumberId,displayName:data.displayName,isActive:data.isActive},select});
        await this.audit(tx,row.id,'whatsapp.connection_created',null,row);return row;
      });
    } catch(error) {
      if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2002') throw new HttpError(409,'CONNECTION_UNAVAILABLE');
      throw error;
    }
  }
  async update(connectionId: string, input: unknown) {
    this.permit(); id.parse(connectionId); const patch=connectionPatch.parse(input),tenantId=this.auth.user.tenantId;
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE id=${connectionId} AND "tenantId"=${tenantId} AND channel='WHATSAPP' FOR UPDATE`;
      const before=await tx.channelConnection.findFirst({where:{id:connectionId,tenantId,channel:'WHATSAPP'},select});
      if(!before) throw new HttpError(404,'NOT_FOUND');
      if(patch.isActive===true) {
        const proof=await tx.channelConnection.findUniqueOrThrow({where:{id:connectionId,tenantId}});
        if(!['VERIFIED','ACTIVE'].includes(proof.whatsappState) || !proof.lastVerifiedAt || !proof.verificationExpiresAt ||
          !proof.credentialDigest || !await this.ownership.current(proof,{environment:proof.whatsappEnvironment as WhatsAppEnvironment,
          credentialDigest:proof.credentialDigest,expiresAt:proof.verificationExpiresAt})) throw new HttpError(409,'OWNERSHIP_VERIFICATION_REQUIRED');
        if(proof.whatsappEnvironment==='META_PRODUCTION' && !this.activation.allowsProduction(proof)) throw new HttpError(409,'PRODUCTION_WHATSAPP_DISABLED');
      }
      const row=await tx.channelConnection.update({where:{id:connectionId,tenantId},data:{...patch, ...(patch.isActive===true ? {whatsappState:'ACTIVE',verificationAttempt:null} : patch.isActive===false ? {whatsappState:before.lastVerifiedAt ? 'VERIFIED':'PENDING_VERIFICATION',verificationAttempt:null} : {})},select});
      await this.audit(tx,row.id,'whatsapp.connection_updated',before,row);return row;
    });
  }
  async verify(connectionId:string) {
    this.permit();id.parse(connectionId);const tenantId=this.auth.user.tenantId,attempt=randomUUID();
    const connection=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE id=${connectionId} AND "tenantId"=${tenantId} AND channel='WHATSAPP' FOR UPDATE`;
      const before=await tx.channelConnection.findFirst({where:{id:connectionId,tenantId,channel:'WHATSAPP'}});
      if(!before) throw new HttpError(404,'NOT_FOUND');
      const row=await tx.channelConnection.update({where:{id:connectionId,tenantId},data:{whatsappState:'PENDING_VERIFICATION',
        isActive:false,lastVerifiedAt:null,verificationExpiresAt:null,credentialDigest:null,verificationAttempt:attempt}});
      await this.audit(tx,row.id,'whatsapp.verification_requested',{state:before.whatsappState,isActive:before.isActive},{state:'PENDING_VERIFICATION',isActive:false});return row;
    });
    try {
      const proof=await this.ownership.verify(connection);
      if(proof.expiresAt<=this.clock()) throw new HttpError(503,'META_OWNERSHIP_VERIFICATION_FAILED');
      return await this.db.$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE id=${connectionId} AND "tenantId"=${tenantId} FOR UPDATE`;
        const current=await tx.channelConnection.findUniqueOrThrow({where:{id:connectionId,tenantId}});
        if(current.verificationAttempt!==attempt) throw new HttpError(409,'VERIFICATION_SUPERSEDED');
        if(!await this.ownership.current(current,proof)) throw new HttpError(503,'META_OWNERSHIP_VERIFICATION_FAILED');
        const incompatible=await tx.whatsAppInbound.count({where:{tenantId,connectionId,source:{notIn:[proof.environment,'META_LEGACY_UNCLASSIFIED']}}});
        if(incompatible) throw new HttpError(409,'CONNECTION_ENVIRONMENT_CONFLICT');
        const row=await tx.channelConnection.update({where:{id:connectionId,tenantId},data:{whatsappState:'VERIFIED',isActive:false,
          whatsappEnvironment:proof.environment,lastVerifiedAt:this.clock(),verificationExpiresAt:proof.expiresAt,
          credentialDigest:proof.credentialDigest,verificationAttempt:null},select});
        await this.audit(tx,row.id,'whatsapp.ownership_verified',null,{state:'VERIFIED',environment:proof.environment,method:'META_GRAPH_ASSET_ACCESS'});return row;
      });
    } catch(error) {
      await this.db.$transaction(async tx=>{
        const updated=await tx.channelConnection.updateMany({where:{id:connectionId,tenantId,verificationAttempt:attempt},data:{verificationAttempt:null}});
        if(updated.count) await this.audit(tx,connectionId,'whatsapp.verification_failed',null,{state:'PENDING_VERIFICATION',code:'VERIFICATION_FAILED'});
      });
      if(error instanceof HttpError) throw error;throw new HttpError(503,'META_OWNERSHIP_VERIFICATION_FAILED');
    }
  }
  private audit(tx: Prisma.TransactionClient,entityId:string,action:string,before:unknown,after:unknown) {
    // Dates become ISO strings; allowlisted mappings never include encrypted credentials.
    return tx.auditLog.create({data:{tenantId:this.auth.user.tenantId,actorId:this.auth.user.id,actorType:'USER',
      entityType:'ChannelConnection',entityId,action,after:JSON.parse(JSON.stringify({before,after}))}});
  }
}
