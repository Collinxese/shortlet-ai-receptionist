import { ownershipUnavailable, productionDisabled, type WhatsAppOwnership, type WhatsAppActivationPolicy, type WhatsAppEnvironment } from './whatsapp-ownership.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import { HttpError } from './errors.js';
import { bodyDigest, identityDigest, normalizeMetaPayload, verifyMetaSignature, type InboundItem } from './whatsapp-validation.js';
import { lockInboundUsage, recordInboundUsage } from './usage-inbound.js';
import { usagePeriod } from './usage-validation.js';

const provider='META_WHATSAPP';
const transactionOptions={isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:10000,timeout:10000};
/** No model, booking, payment or outbound transport dependencies. */
export class WhatsAppWebhook {
  constructor(private readonly db: PrismaClient, private readonly secret: string, private readonly clock=()=>new Date(),private readonly ownership:WhatsAppOwnership=ownershipUnavailable,
    private readonly activation:WhatsAppActivationPolicy=productionDisabled) {}
  async receive(raw: Buffer, signature: string | string[] | undefined) {
    verifyMetaSignature(raw,signature,this.secret);
    const eventId=bodyDigest(raw), receivedAt=this.clock();
    let items: InboundItem[]=[]; let malformed=false;
    try {items=normalizeMetaPayload(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),receivedAt);} catch {malformed=true;}
    // Receipt contains only a digest and outcomes. Raw payload, sender and text are never copied here.
    try {
      // createMany uses INSERT ... ON CONFLICT DO NOTHING. An empty-update Prisma
      // upsert may perform a read followed by insert and race on first delivery.
      await this.db.webhookEvent.createMany({data:[{provider,eventId,eventType:'INBOUND',rawBody:{bodyHash:eventId},receivedAt}],skipDuplicates:true});
      const receipt=await this.db.webhookEvent.findUniqueOrThrow({where:{provider_eventId:{provider,eventId}}});
      await this.db.$transaction(async tx=>{
        // Same mode lock as Phase 6A, then receipt -> connection -> conversation.
        await lockInboundUsage(tx,'SIMULATION');
        await lockInboundUsage(tx,'PRODUCTION');
        await tx.$queryRaw`SELECT id FROM "WebhookEvent" WHERE id=${receipt.id} FOR UPDATE`;
        const current=await tx.webhookEvent.findUniqueOrThrow({where:{id:receipt.id}});
        if(current.status==='PROCESSED') return;
        const outcomes: Record<string,number>={};
        if(malformed) outcomes.MALFORMED=1;
        else for(const item of items) {
          const result=await this.record(tx,item,receivedAt);
          outcomes[result]=(outcomes[result] ?? 0)+1;
        }
        await tx.webhookEvent.update({where:{id:receipt.id},data:{status:'PROCESSED',processedAt:this.clock(),
          lastError:malformed ? 'INVALID_WEBHOOK_PAYLOAD':null,rawBody:{bodyHash:eventId,outcomes}}});
      },transactionOptions);
    } catch {
      // Do not overwrite a completed concurrent retry. This best-effort marker cannot turn failure into success.
      try {await this.db.webhookEvent.updateMany({where:{provider,eventId,status:{not:'PROCESSED'}},
        data:{status:'RETRY',lastError:'DATABASE_PROCESSING_FAILED'}});} catch { /* Database may be unavailable. Sender must retry. */ }
      throw new HttpError(503,'WEBHOOK_RETRY_REQUIRED');
    }
    if(malformed) throw new HttpError(400,'INVALID_WEBHOOK_PAYLOAD');
    return {received:true};
  }
  private async record(tx: Prisma.TransactionClient,item: InboundItem,now: Date): Promise<string> {
    if(item.kind!=='TEXT') return item.kind;
    await tx.$queryRaw`SELECT id FROM "ChannelConnection" WHERE channel='WHATSAPP' AND "externalPhoneNumberId"=${item.phoneNumberId} FOR UPDATE`;
    const connection=await tx.channelConnection.findUnique({where:{channel_externalPhoneNumberId:{channel:'WHATSAPP',externalPhoneNumberId:item.phoneNumberId}},select:{id:true,tenantId:true,isActive:true,externalBusinessId:true,externalPhoneNumberId:true,whatsappState:true,whatsappEnvironment:true,lastVerifiedAt:true,verificationExpiresAt:true,credentialDigest:true}});
    if(!connection) return 'UNKNOWN_NUMBER';
    if(connection.whatsappState==='PENDING_VERIFICATION' || !connection.lastVerifiedAt) return 'UNVERIFIED_NUMBER';
    if(!connection.isActive || connection.whatsappState!=='ACTIVE') return 'INACTIVE_NUMBER';
    if(!connection.verificationExpiresAt || connection.verificationExpiresAt<=this.clock() || !connection.credentialDigest) return 'VERIFICATION_EXPIRED';
    if(!['META_TEST','META_PRODUCTION'].includes(connection.whatsappEnvironment)) return 'UNVERIFIED_NUMBER';
    if(connection.whatsappEnvironment==='META_PRODUCTION' && !this.activation.allowsProduction(connection)) return 'PRODUCTION_DISABLED';
    if(!await this.ownership.current(connection,{environment:connection.whatsappEnvironment as WhatsAppEnvironment,
      credentialDigest:connection.credentialDigest,expiresAt:connection.verificationExpiresAt})) return 'VERIFICATION_REVOKED';
    const source=connection.whatsappEnvironment as WhatsAppEnvironment,mode=source==='META_TEST' ? 'SIMULATION':'PRODUCTION';
    if(connection.externalBusinessId!==item.businessId) return 'BUSINESS_MISMATCH';
    const tenantId=connection.tenantId;
    const old=await tx.whatsAppInbound.findUnique({where:{tenantId_phoneNumberId_metaMessageId:{tenantId,
      phoneNumberId:item.phoneNumberId,metaMessageId:item.metaMessageId}}});
    if(old) return old.inputHash===item.inputHash ? 'DUPLICATE':'MESSAGE_ID_CONFLICT';
    const externalId=`whatsapp:${identityDigest([connection.id,item.phone])}`;
    let conversation=await tx.conversation.findUnique({where:{tenantId_channel_externalId:{tenantId,channel:'WHATSAPP',externalId}}});
    if(conversation && (conversation.simulation || conversation.guestPhone!==item.phone || conversation.handlingMode!=='HUMAN')) return 'CONVERSATION_CONFLICT';
    if(!conversation) conversation=await tx.conversation.create({data:{tenantId,channel:'WHATSAPP',externalId,guestPhone:item.phone,
      simulation:false,handlingMode:'HUMAN',needsAttention:true}});
    const audit=(entityId:string,action:string,after:Prisma.InputJsonObject)=>tx.auditLog.create({data:{tenantId,actorType:'SYSTEM',
      entityType:'WhatsAppInbound',entityId,action,after}});
    const accountingAt=this.clock();
    const usage=await recordInboundUsage(tx,{tenantId,mode,source,now:accountingAt,
      configuration:async()=>({policy:await tx.usagePolicy.findUnique({where:{tenantId_mode:{tenantId,mode}}})}),
      audit,alert:async(code,threshold=0)=>{
        const key={tenantId,mode,periodStart:usagePeriod(accountingAt).start,code,threshold};
        if(!await tx.usageAlert.findUnique({where:{tenantId_mode_periodStart_code_threshold:key}})) {
          const alert=await tx.usageAlert.create({data:key});await audit(alert.id,'usage.alert',{mode,source,code,threshold});
        }
      }},{phone:item.phone,eventId:identityDigest(['META_WHATSAPP',item.phoneNumberId,item.metaMessageId]),conversationId:conversation.id});
    const message=await tx.message.create({data:{tenantId,conversationId:conversation.id,direction:'IN',body:item.text,
      providerId:`whatsapp:${identityDigest([tenantId,item.phoneNumberId,item.metaMessageId])}`,createdAt:now}});
    const inbound=await tx.whatsAppInbound.create({data:{tenantId,source,connectionId:connection.id,phoneNumberId:item.phoneNumberId,
      metaMessageId:item.metaMessageId,inputHash:item.inputHash,conversationId:conversation.id,messageId:message.id,
      eventAt:item.eventAt,receivedAt:now,usageStatus:usage.status}});
    await tx.conversation.update({where:{id:conversation.id,tenantId},data:{lastMessageAt:conversation.lastMessageAt && conversation.lastMessageAt > now ? conversation.lastMessageAt : now,needsAttention:true}});
    await audit(inbound.id,'whatsapp.message_received',{conversationId:conversation.id,connectionId:connection.id,
      accountingMode:mode,source,usageStatus:usage.status});
    return usage.status==='ACCEPTED' ? 'RECORDED':'RECORDED_USAGE_BLOCKED';
  }
}
