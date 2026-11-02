import { z } from 'zod';
import { id } from './validation.js';
import { guestPhone, idempotencyKey } from './booking-validation.js';

export const usageMode = z.enum(['SIMULATION','PRODUCTION']);
export type UsageMode = z.infer<typeof usageMode>;
export const provisionalPlans = { STARTER: 300, GROWTH: 1000, PRO: 3000 } as const;
export const microAmount = z.string().regex(/^(0|[1-9]\d{0,14})$/).transform(BigInt);
export const usagePolicyBody = z.strictObject({
  plan: z.enum(['STARTER','GROWTH','PRO']), conversationAllowance: z.number().int().min(0).max(1_000_000).optional(),
  monthlyCapMicroUsd: microAmount, minimumReservationMicroUsd: microAmount,
  maxRequestMicroUsd: microAmount, maxInputBytes: z.number().int().min(1).max(32768),
  maxOutputTokens: z.number().int().min(1).max(4000), maxCallsPerTurn: z.number().int().min(1).max(4),
  maxRetries: z.number().int().min(0).max(3)
}).refine((v) => v.minimumReservationMicroUsd <= v.maxRequestMicroUsd && v.maxRequestMicroUsd > 0n && v.maxRetries < v.maxCallsPerTurn);
export const usageQuery = z.strictObject({ mode: usageMode.default('SIMULATION'), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const modeParams = z.strictObject({ mode: usageMode });
export const eventParams = z.strictObject({ eventId: id });
export const fixtureBody = z.strictObject({
  conversationId: id.optional(), inputTokens: z.number().int().min(0).max(32768), outputTokens: z.number().int().min(0).max(4000),
  outcome: z.enum(['complete','known_failure','unknown']).default('complete')
});
export const inboundBody = z.strictObject({ phone: guestPhone, eventId: idempotencyKey });
export const reconciliationBody = z.strictObject({ inputTokens: z.number().int().min(0).max(32768), outputTokens: z.number().int().min(0).max(4000) });
export const TEST_PRICING = Object.freeze({ provider: 'mock', model: 'mock-planner-v1', version: 'UNVERIFIED-TEST-USD-v1',
  inputRate: 2n, outputRate: 5n, currency: 'USD' });
// Calendar months in Africa/Lagos (UTC+01:00, no daylight-saving time).
export function usagePeriod(now: Date) {
  const local = new Date(now.getTime()+3600000), year = local.getUTCFullYear(), month = local.getUTCMonth();
  return { start: new Date(Date.UTC(year,month,1)-3600000), end: new Date(Date.UTC(year,month+1,1)-3600000) };
}
export function tokenCost(input: number, output: number, inputRate: bigint = TEST_PRICING.inputRate, outputRate: bigint = TEST_PRICING.outputRate) {
  if (![input,output].every((n) => Number.isSafeInteger(n) && n >= 0) || inputRate < 0n || outputRate < 0n) throw new Error('INVALID_USAGE');
  return BigInt(input)*inputRate + BigInt(output)*outputRate;
}
export function warningThresholds(used: bigint, cap: bigint) { return [70,85,100].filter((n) => cap === 0n || used*100n >= cap*BigInt(n)); }
export function usageJson<T>(value: T): any { return JSON.parse(JSON.stringify(value,(_key,v) => typeof v === 'bigint' ? v.toString() : v)); }
export const developmentUsagePolicy = () => usagePolicyBody.parse({ plan: 'STARTER', monthlyCapMicroUsd: '10000000',
  minimumReservationMicroUsd: '1000', maxRequestMicroUsd: '100000', maxInputBytes: 16384, maxOutputTokens: 1500, maxCallsPerTurn: 2, maxRetries: 1 });
export type UsageRuntime = { developmentDefaults: boolean; simulationGlobalCapMicroUsd?: bigint; productionGlobalCapMicroUsd?: bigint };
export const localUsageRuntime = (): UsageRuntime => ({ developmentDefaults: process.env.NODE_ENV !== 'production' });
