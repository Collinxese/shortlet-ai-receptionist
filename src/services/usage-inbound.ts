import type { Prisma, UsagePolicy } from '@prisma/client';
import { createHash } from 'node:crypto';
import { guestPhone, idempotencyKey } from './booking-validation.js';
import { HttpError } from './errors.js';
import { usageJson, usagePeriod, warningThresholds, type UsageMode } from './usage-validation.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function lockInboundUsage(tx: Prisma.TransactionClient, mode: UsageMode) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`usage-ledger:${mode}`}, 61))::text`;
}
/** Shared accounting primitive. Caller owns the transaction and holds the mode lock.
 * The webhook supplies only a database-resolved tenant and a verified conversation.
 * Receipt, window, message and audit can therefore commit or roll back together. */
export async function recordInboundUsage(tx: Prisma.TransactionClient, context: {
  tenantId: string; mode: UsageMode; now: Date; source?:'INTERNAL_SIMULATION'|'META_TEST'|'META_PRODUCTION';
  configuration: () => Promise<{ policy: UsagePolicy | null }>;
  audit: (entityId: string, action: string, after: Prisma.InputJsonObject) => Promise<unknown>;
  alert: (code: string, threshold?: number) => Promise<unknown>;
}, input: { phone: string; eventId: string; conversationId?: string }) {
  const mode = context.mode,source=context.source ?? (mode==='SIMULATION' ? 'INTERNAL_SIMULATION':'META_PRODUCTION');
  if((source==='META_PRODUCTION') !== (mode==='PRODUCTION')) throw new HttpError(400,'INVALID_USAGE_SOURCE');
  const phone = guestPhone.parse(input.phone), eventHash = digest(idempotencyKey.parse(input.eventId));
  const identityHash = digest([context.tenantId,'WHATSAPP',phone]), inputHash = digest([identityHash,input.conversationId ?? null]);
  const windowIdentityHash=digest([identityHash,source]);
  const sources=source==='INTERNAL_SIMULATION' ? ['INTERNAL_SIMULATION','LEGACY_MIXED']:[source];
  const old = await tx.usageInbound.findUnique({ where: { tenantId_mode_eventHash: { tenantId: context.tenantId, mode, eventHash } } });
  if (old) { if (old.inputHash !== inputHash) throw new HttpError(409,'IDEMPOTENCY_CONFLICT'); return usageJson(old); }
  const now = context.now, period = usagePeriod(now), { policy } = source==='META_TEST' ? {policy:null} : await context.configuration();
  let window = await tx.usageWindow.findFirst({ where: { tenantId: context.tenantId, mode, identityHash:windowIdentityHash, source:{in:sources}, expiresAt: { gt: now } }, orderBy: { startedAt: 'desc' } });
  const count = await tx.usageWindow.count({ where: { tenantId: context.tenantId, mode, source:{in:sources}, periodStart: period.start } });
  let status = 'ACCEPTED';
  if (source!=='META_TEST' && (!policy || (!window && count >= policy.conversationAllowance))) {
    status = 'BLOCKED'; await context.alert(policy ? 'CONVERSATION_ALLOWANCE' : 'USAGE_CONFIGURATION_MISSING');
  } else {
    // Concurrent ingress may capture receipt times before acquiring the ledger lock.
    const inboundAt = window && window.lastInboundAt > now ? window.lastInboundAt : now;
    const expiresAt = new Date(inboundAt.getTime()+24*3600000);
    if (window) window = await tx.usageWindow.update({ where: { id: window.id, tenantId: context.tenantId }, data: { lastInboundAt: inboundAt, expiresAt } });
    else {
      window = await tx.usageWindow.create({ data: { tenantId: context.tenantId, mode, source, identityHash:windowIdentityHash, periodStart: period.start,
        periodEnd: period.end, startedAt: now, lastInboundAt: now, expiresAt } });
      await context.audit(window.id,'usage.conversation_started',{ mode, source, periodStart: period.start.toISOString(), provisional: true });
      if(policy) for (const threshold of warningThresholds(BigInt(count+1),BigInt(policy.conversationAllowance))) await context.alert('CONVERSATION_WARNING',threshold);
    }
  }
  const receipt = await tx.usageInbound.create({ data: { tenantId: context.tenantId, mode, source, eventHash, inputHash,
    windowId: status === 'ACCEPTED' ? window!.id : null, status, receivedAt: now } });
  return usageJson(receipt);
}
