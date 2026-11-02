import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { hasPermission } from './authorization.js';
import { HttpError } from './errors.js';
import { connectionBody, connectionPatch } from './whatsapp-validation.js';
import { id } from './validation.js';
import { conversationListQuery } from './conversation-validation.js';

const select = { id:true, externalBusinessId:true, externalPhoneNumberId:true, displayName:true, isActive:true,
  createdAt:true, updatedAt:true } satisfies Prisma.ChannelConnectionSelect;
/** Only safe mapping fields are read or written. No credential transport or Embedded Signup. */
export class WhatsAppConnections {
  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext) {}
  private permit() { if (!hasPermission(this.auth.user.role,'whatsapp:manage')) throw new HttpError(403,'FORBIDDEN'); }
  async list(input: unknown) {
    this.permit(); const {limit,offset}=conversationListQuery.parse(input);
    return { connections: await this.db.channelConnection.findMany({where:{tenantId:this.auth.user.tenantId,channel:'WHATSAPP'},
      select,orderBy:[{createdAt:'desc'},{id:'desc'}],take:limit,skip:offset}), limit,offset, accountingMode:'SIMULATION' };
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
      const row=await tx.channelConnection.update({where:{id:connectionId,tenantId},data:patch,select});
      await this.audit(tx,row.id,'whatsapp.connection_updated',before,row);return row;
    });
  }
  private audit(tx: Prisma.TransactionClient,entityId:string,action:string,before:unknown,after:unknown) {
    // Dates become ISO strings; allowlisted mappings never include encrypted credentials.
    return tx.auditLog.create({data:{tenantId:this.auth.user.tenantId,actorId:this.auth.user.id,actorType:'USER',
      entityType:'ChannelConnection',entityId,action,after:JSON.parse(JSON.stringify({before,after,accountingMode:'SIMULATION'}))}});
  }
}
