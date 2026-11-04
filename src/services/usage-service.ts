import { recordInboundUsage, lockInboundUsage } from './usage-inbound.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type UsageEvent } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from './authentication.js';
import { hasPermission, type Permission } from './authorization.js';
import { HttpError } from './errors.js';
import { id } from './validation.js';
import { guestPhone, idempotencyKey } from './booking-validation.js';
import { developmentUsagePolicy, localUsageRuntime, provisionalPlans, TEST_PRICING, tokenCost, usageJson,
  usageMode, usagePeriod, usagePolicyBody, warningThresholds, fixtureBody, type UsageMode, type UsageRuntime } from './usage-validation.js';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 10000 };
const reserveBody = z.strictObject({ key: idempotencyKey, inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  estimatedInputTokens: z.number().int().min(0).max(32768), conversationId: id.optional(), turnId: id.optional() })
  .refine((v) => !v.turnId || Boolean(v.conversationId));
export class MockUsageFailure extends Error { constructor(readonly knownZero: boolean) { super('MOCK_USAGE_FAILURE'); } }

/** No raw text, credentials or phone is accepted by the financial ledger. All money is bigint micro-USD. */
export class UsageService {
  private readonly tenantId: string;
  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext,
    private readonly runtime: UsageRuntime = localUsageRuntime(), private readonly clock = () => new Date()) {
    this.tenantId = auth.user.tenantId;
    if (!this.tenantId) throw new HttpError(401,'UNAUTHORIZED');
  }
  private permit(p: Permission) { if (!hasPermission(this.auth.user.role,p)) throw new HttpError(403,'FORBIDDEN'); }
  // All accounting/configuration writes use this order: global mode lock -> conversation (if needed).
  // Serializing the short ledger transactions also protects aggregate cap checks across instances.
  private async lock(tx: Prisma.TransactionClient, mode: UsageMode) {
    await lockInboundUsage(tx,mode);
  }
  private audit(tx: Prisma.TransactionClient, entityId: string, action: string, after: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: { tenantId: this.tenantId, actorId: this.auth.user.id, actorType: 'USER',
      entityType: 'Usage', entityId, action, after } });
  }
  private async alert(tx: Prisma.TransactionClient, mode: UsageMode, code: string, threshold = 0, start = usagePeriod(this.clock()).start) {
    const where = { tenantId: this.tenantId, mode, periodStart: start, code, threshold };
    if (!await tx.usageAlert.findUnique({ where: { tenantId_mode_periodStart_code_threshold: where } })) {
      const row = await tx.usageAlert.create({ data: where });
      await this.audit(tx,row.id,'usage.alert',{ mode, code, threshold });
    }
  }
  private async configuration(tx: Prisma.TransactionClient, mode: UsageMode) {
    let policy = await tx.usagePolicy.findUnique({ where: { tenantId_mode: { tenantId: this.tenantId, mode } } });
    let global = await tx.usageGlobalPolicy.findUnique({ where: { mode } });
    if (!global && mode === 'PRODUCTION' && this.runtime.productionGlobalCapMicroUsd !== undefined) {
      global = await tx.usageGlobalPolicy.create({ data: { mode, monthlyCapMicroUsd: this.runtime.productionGlobalCapMicroUsd } });
      await this.audit(tx,mode,'usage.global_policy_initialized',{ mode, source: 'SERVER_CONFIGURATION' });
    }
    if (mode === 'SIMULATION' && this.runtime.developmentDefaults) {
      if (!global) global = await tx.usageGlobalPolicy.create({ data: { mode,
        monthlyCapMicroUsd: this.runtime.simulationGlobalCapMicroUsd ?? 100000000n } });
      if (!policy) {
        const data = developmentUsagePolicy();
        policy = await tx.usagePolicy.create({ data: { ...data, conversationAllowance: provisionalPlans[data.plan], tenantId: this.tenantId, mode } });
        await this.audit(tx,policy.id,'usage.development_defaults_created',{ mode, unverifiedTestPricing: true });
      }
    }
    return { policy, global };
  }
  async configure(modeInput: unknown, input: unknown) {
    this.permit('usage:write');
    const mode = usageMode.parse(modeInput), data = usagePolicyBody.parse(input);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx,mode);
      const before = await tx.usagePolicy.findUnique({ where: { tenantId_mode: { tenantId: this.tenantId, mode } } });
      const values = { ...data, conversationAllowance: data.conversationAllowance ?? provisionalPlans[data.plan] };
      const row = await tx.usagePolicy.upsert({ where: { tenantId_mode: { tenantId: this.tenantId, mode } },
        create: { ...values, tenantId: this.tenantId, mode }, update: values });
      await this.audit(tx,row.id,'usage.policy_changed',usageJson({ mode, before, after: row, provisional: true }));
      return usageJson(row);
    },options);
  }
  async summary(modeInput: unknown) {
    this.permit('usage:read'); const mode = usageMode.parse(modeInput), period = usagePeriod(this.clock());
    return this.db.$transaction(async (tx) => {
      await this.lock(tx,mode);
      const { policy } = await this.configuration(tx,mode);
      const cost = await tx.usageEvent.aggregate({ where: { tenantId: this.tenantId, mode, periodStart: period.start }, _sum: { accountedMicroUsd: true } });
      const ticketsBySource=await tx.usageWindow.groupBy({by:['source'],where:{tenantId:this.tenantId,mode,periodStart:period.start},_count:true});
      const countedSources=mode==='SIMULATION' ? ['INTERNAL_SIMULATION','LEGACY_MIXED']:['META_PRODUCTION'];
      const conversations=ticketsBySource.filter(row=>countedSources.includes(row.source)).reduce((sum,row)=>sum+row._count,0);
      return usageJson({ mode, simulated: mode === 'SIMULATION', currency: 'USD', unit: 'micro-USD', period,
        policy, ticketsBySource, accountedMicroUsd: cost._sum.accountedMicroUsd ?? 0n, conversations, provisional: true });
    },options);
  }
  async list(mode: UsageMode, limit: number) {
    this.permit('usage:read'); usageMode.parse(mode); z.number().int().min(1).max(100).parse(limit);
    return usageJson(await this.db.usageEvent.findMany({ where: { tenantId: this.tenantId, mode }, orderBy: [{ reservedAt: 'desc' },{ id: 'desc' }], take: limit }));
  }
  async alerts(mode: UsageMode, limit: number) {
    this.permit('usage:read'); usageMode.parse(mode); z.number().int().min(1).max(100).parse(limit);
    return this.db.usageAlert.findMany({ where: { tenantId: this.tenantId, mode }, orderBy: { createdAt: 'desc' }, take: limit });
  }
  async get(eventId: string) {
    this.permit('usage:read');
    const row = await this.db.usageEvent.findFirst({ where: { id: id.parse(eventId), tenantId: this.tenantId } });
    if (!row) throw new HttpError(404,'NOT_FOUND'); return usageJson(row);
  }
  async reserve(input: unknown, mode: UsageMode = 'SIMULATION', guard?: (tx: Prisma.TransactionClient) => Promise<void>) {
    this.permit('inbox:reply'); usageMode.parse(mode); const data = reserveBody.parse(input);
    const keyDigest = digest(data.key);
    const result = await this.db.$transaction(async (tx) => {
      await this.lock(tx,mode);
      if (data.conversationId) {
        const row = await tx.conversation.findFirst({ where: { id: data.conversationId, tenantId: this.tenantId, simulation: mode === 'SIMULATION' } });
        if (!row) throw new HttpError(404,'NOT_FOUND');
      }
      if (guard) await guard(tx);
      const old = await tx.usageEvent.findUnique({ where: { tenantId_mode_key: { tenantId: this.tenantId, mode, key: keyDigest } } });
      const inputHash = digest(data);
      if (old) {
        if (old.inputHash !== inputHash) throw new HttpError(409,'IDEMPOTENCY_CONFLICT');
        return { event: old, replay: true };
      }
      const now = this.clock(), period = usagePeriod(now), { policy, global } = await this.configuration(tx,mode);
      const deny = async (code: string) => { await this.alert(tx,mode,code); return { error: code }; };
      if (!policy || !global) return deny('USAGE_CONFIGURATION_MISSING');
      if (mode !== 'SIMULATION') return deny('PRODUCTION_AI_DISABLED');
      if (data.estimatedInputTokens > policy.maxInputBytes) return deny('USAGE_INPUT_LIMIT');
      if (data.turnId) {
        const calls = await tx.usageEvent.count({ where: { tenantId: this.tenantId, mode, turnId: data.turnId } });
        if (calls >= policy.maxCallsPerTurn || calls > policy.maxRetries) return deny('USAGE_TURN_LIMIT');
      }
      const bound = tokenCost(data.estimatedInputTokens,policy.maxOutputTokens);
      const reserve = bound > policy.minimumReservationMicroUsd ? bound : policy.minimumReservationMicroUsd;
      if (reserve > policy.maxRequestMicroUsd) return deny('USAGE_REQUEST_LIMIT');
      const tenant = await tx.usageEvent.aggregate({ where: { tenantId: this.tenantId, mode, periodStart: period.start }, _sum: { accountedMicroUsd: true } });
      const all = await tx.usageEvent.aggregate({ where: { mode, periodStart: period.start }, _sum: { accountedMicroUsd: true } });
      const tenantUsed = tenant._sum.accountedMicroUsd ?? 0n, globalUsed = all._sum.accountedMicroUsd ?? 0n;
      if (tenantUsed + reserve > policy.monthlyCapMicroUsd) return deny('TENANT_AI_CAP');
      if (globalUsed + reserve > global.monthlyCapMicroUsd) return deny('GLOBAL_AI_CAP');
      const event = await tx.usageEvent.create({ data: { tenantId: this.tenantId, mode, key: keyDigest, inputHash,
        conversationId: data.conversationId, turnId: data.turnId, correlationId: randomUUID(), periodStart: period.start, periodEnd: period.end,
        provider: TEST_PRICING.provider, model: TEST_PRICING.model, pricingVersion: TEST_PRICING.version,
        inputRateMicroUsd: TEST_PRICING.inputRate, outputRateMicroUsd: TEST_PRICING.outputRate,
        estimatedInputTokens: data.estimatedInputTokens, estimatedOutputTokens: policy.maxOutputTokens,
        reservedMicroUsd: reserve, accountedMicroUsd: reserve, reservedAt: now, reservationExpiresAt: new Date(now.getTime()+120000) } });
      for (const threshold of warningThresholds(tenantUsed+reserve,policy.monthlyCapMicroUsd)) await this.alert(tx,mode,'TENANT_AI_WARNING',threshold);
      for (const threshold of warningThresholds(globalUsed+reserve,global.monthlyCapMicroUsd)) await this.alert(tx,mode,'GLOBAL_AI_WARNING',threshold);
      await this.audit(tx,event.id,'usage.reserved',{ mode, correlationId: event.correlationId, reservedMicroUsd: reserve.toString() });
      return { event, replay: false };
    },options);
    if ('error' in result) throw new HttpError(409,result.error!);
    return result;
  }
  private async event(tx: Prisma.TransactionClient, eventId: string) {
    const row = await tx.usageEvent.findFirst({ where: { id: eventId, tenantId: this.tenantId } });
    if (!row) throw new HttpError(404,'NOT_FOUND'); return row;
  }
  async dispatch(eventId: string, guard?: (tx: Prisma.TransactionClient) => Promise<void>) {
    this.permit('inbox:reply');
    const mode = usageMode.parse((await this.event(this.db,eventId)).mode);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx,mode); const row = await this.event(tx,eventId);
      if (guard) await guard(tx);
      if (row.status !== 'RESERVED' || row.dispatchedAt || row.reservationExpiresAt <= this.clock()) throw new HttpError(409,'USAGE_NOT_DISPATCHABLE');
      // Recheck at dispatch: a reservation made in the previous month cannot fund a new-month call.
      if (row.periodStart.getTime() !== usagePeriod(this.clock()).start.getTime()) throw new HttpError(409,'USAGE_PERIOD_CHANGED');
      const updated = await tx.usageEvent.update({ where: { id: row.id, tenantId: this.tenantId }, data: { dispatchedAt: this.clock() } });
      await this.audit(tx,row.id,'usage.dispatched',{ correlationId: row.correlationId }); return updated;
    },options);
  }
  async settle(eventId: string, outcome: { kind: 'complete'; inputTokens: number; outputTokens: number } | { kind: 'unknown' | 'known_failure' | 'release' }) {
    this.permit('inbox:reply');
    const mode = usageMode.parse((await this.event(this.db,eventId)).mode);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx,mode); const row = await this.event(tx,eventId), now = this.clock(), settlementHash = digest(outcome);
      if (row.settlementHash === settlementHash) return row;
      if (['COMPLETED','FAILED','RELEASED'].includes(row.status)) throw new HttpError(409,'USAGE_ALREADY_SETTLED');
      if (outcome.kind === 'release' && row.dispatchedAt) throw new HttpError(409,'USAGE_OUTCOME_UNKNOWN');
      if (outcome.kind !== 'release' && !row.dispatchedAt) throw new HttpError(409,'USAGE_NOT_DISPATCHED');
      let patch: Prisma.UsageEventUpdateInput;
      if (outcome.kind === 'complete') {
        const { inputTokens, outputTokens } = outcome;
        const cost = tokenCost(inputTokens,outputTokens,row.inputRateMicroUsd,row.outputRateMicroUsd);
        if (inputTokens > row.estimatedInputTokens || outputTokens > row.estimatedOutputTokens || cost > row.reservedMicroUsd) {
          throw new HttpError(409,'USAGE_BOUND_EXCEEDED');
        }
        patch = { status: 'COMPLETED', actualInputTokens: inputTokens, actualOutputTokens: outputTokens, actualMicroUsd: cost,
          accountedMicroUsd: cost, completedAt: now, reconciledAt: now, releasedAt: cost < row.reservedMicroUsd ? now : null, errorCategory: null, settlementHash };
      } else if (outcome.kind === 'unknown') {
        patch = { status: 'REVIEW', failedAt: now, errorCategory: 'OUTCOME_UNKNOWN', settlementHash };
        await this.alert(tx,mode,'USAGE_REVIEW_REQUIRED');
      } else {
        patch = { status: outcome.kind === 'release' ? 'RELEASED' : 'FAILED', accountedMicroUsd: 0n,
          releasedAt: now, reconciledAt: now, failedAt: outcome.kind === 'known_failure' ? now : null,
          errorCategory: outcome.kind === 'known_failure' ? 'KNOWN_ZERO_USAGE' : 'NOT_DISPATCHED', settlementHash };
      }
      const updated = await tx.usageEvent.update({ where: { id: row.id, tenantId: this.tenantId }, data: patch });
      await this.audit(tx,row.id,'usage.settled',usageJson({ status: updated.status, accountedMicroUsd: updated.accountedMicroUsd, mode }));
      return updated;
    },options);
  }
  // Recovery never assumes a timeout means zero usage. Delayed known results can still reconcile REVIEW.
  async recover() {
    this.permit('usage:write');
    return this.db.$transaction(async (tx) => {
      const recovered: string[] = [];
      for (const mode of ['SIMULATION','PRODUCTION'] as const) {
        await this.lock(tx,mode);
        const rows = await tx.usageEvent.findMany({ where: { tenantId: this.tenantId, mode, status: 'RESERVED', reservationExpiresAt: { lte: this.clock() } }, take: 100 });
        for (const row of rows) {
          await tx.usageEvent.update({ where: { id: row.id, tenantId: this.tenantId }, data: row.dispatchedAt ?
            { status: 'REVIEW', failedAt: this.clock(), errorCategory: 'OUTCOME_UNKNOWN' } :
            { status: 'RELEASED', accountedMicroUsd: 0n, releasedAt: this.clock(), reconciledAt: this.clock(), errorCategory: 'NOT_DISPATCHED' } });
          if (row.dispatchedAt) await this.alert(tx,mode,'USAGE_REVIEW_REQUIRED');
          await this.audit(tx,row.id,'usage.recovered',{ mode, unknown: Boolean(row.dispatchedAt) }); recovered.push(row.id);
        }
      }
      return { recovered };
    },options);
  }
  /** Staff entry point; webhook accounting uses the same transaction-level primitive. */
  async recordInbound(input: { phone: string; eventId: string; conversationId?: string }, mode: UsageMode = 'SIMULATION') {
    this.permit('usage:write'); usageMode.parse(mode);
    const phone = guestPhone.parse(input.phone); idempotencyKey.parse(input.eventId);
    return this.db.$transaction(async (tx) => {
      await this.lock(tx,mode);
      if (mode === 'PRODUCTION' || input.conversationId) {
        const conversation = input.conversationId && await tx.conversation.findFirst({ where: { id: input.conversationId, tenantId: this.tenantId,
          simulation: mode === 'SIMULATION', ...(mode === 'PRODUCTION' ? { channel: 'WHATSAPP' } : {}) } });
        if (!conversation || guestPhone.safeParse(conversation.guestPhone).data !== phone) throw new HttpError(404,'NOT_FOUND');
      }
      return recordInboundUsage(tx, { tenantId: this.tenantId, mode, now: this.clock(),
        configuration: () => this.configuration(tx,mode),
        audit: (entityId,action,after) => this.audit(tx,entityId,action,after),
        alert: (code,threshold) => this.alert(tx,mode,code,threshold) }, input);
    },options);
  }
  async simulate(input: unknown, key: unknown) {
    this.permit('usage:write'); const fixture = fixtureBody.parse(input);
    const reserved = await this.reserve({ key: idempotencyKey.parse(key), inputHash: digest(fixture), estimatedInputTokens: fixture.inputTokens,
      conversationId: fixture.conversationId });
    if (reserved.replay) return usageJson(reserved.event);
    if (fixture.outputTokens > reserved.event.estimatedOutputTokens) {
      await this.settle(reserved.event.id,{ kind: 'release' });
      throw new HttpError(400,'USAGE_BOUND_EXCEEDED');
    }
    await this.dispatch(reserved.event.id);
    return usageJson(await this.settle(reserved.event.id,fixture.outcome === 'complete' ? { kind: 'complete', inputTokens: fixture.inputTokens, outputTokens: fixture.outputTokens } :
      { kind: fixture.outcome === 'known_failure' ? 'known_failure' : 'unknown' }));
  }
  async reconcileSimulation(eventId: string, inputTokens: number, outputTokens: number) {
    this.permit('usage:write'); const row = await this.event(this.db,eventId);
    if (row.mode !== 'SIMULATION') throw new HttpError(403,'FORBIDDEN');
    return usageJson(await this.settle(eventId,{ kind: 'complete', inputTokens, outputTokens }));
  }
}
export const usageInputHash = digest;
