import type { AvailabilityBlock, PriceRule, Prisma } from '@prisma/client';
import { lagosDate } from './calendar.js';

export const propertyInclude = { otherFees: { orderBy: { label: 'asc' as const } } } satisfies Prisma.PropertyInclude;
export type PropertyRecord = Prisma.PropertyGetPayload<{ include: typeof propertyInclude }>;

export function propertyConfiguration(property: PropertyRecord) {
  return {
    name: property.name, area: property.area, address: property.address, description: property.description,
    bedrooms: property.bedrooms, bathrooms: property.bathrooms, maxGuests: property.maxGuests, amenities: property.amenities,
    baseNightlyPriceKobo: Number(property.baseNightlyPriceKobo),
    weekendNightlyPriceKobo: property.weekendNightlyPriceKobo === null ? null : Number(property.weekendNightlyPriceKobo),
    cleaningFeeKobo: Number(property.cleaningFeeKobo),
    otherFees: property.otherFees.map(({ label, amountKobo }) => ({ label, amountKobo: Number(amountKobo) })),
    minimumStayNights: property.minimumStayNights, standardCheckIn: property.standardCheckIn, standardCheckOut: property.standardCheckOut,
    earlyCheckInAllowed: property.earlyCheckInAllowed, earlyCheckInFrom: property.earlyCheckInFrom,
    earlyCheckInFeeKobo: property.earlyCheckInFeeKobo === null ? null : Number(property.earlyCheckInFeeKobo),
    earlyCheckInRules: property.earlyCheckInRules,
    lateCheckOutAllowed: property.lateCheckOutAllowed, lateCheckOutUntil: property.lateCheckOutUntil,
    lateCheckOutFeeKobo: property.lateCheckOutFeeKobo === null ? null : Number(property.lateCheckOutFeeKobo),
    lateCheckOutRules: property.lateCheckOutRules,
    cancellationPolicy: property.cancellationPolicy, refundPolicy: property.refundPolicy, isActive: property.isActive
  };
}

export function propertyResponse(property: PropertyRecord) {
  return {
    id: property.id, tenantId: property.tenantId, ...propertyConfiguration(property), currency: property.currency,
    createdAt: property.createdAt.toISOString(), updatedAt: property.updatedAt.toISOString()
  };
}

export function blockResponse(block: AvailabilityBlock) {
  return {
    id: block.id, propertyId: block.propertyId, startDate: lagosDate(block.startDate), endDate: lagosDate(block.endDate),
    startAt: block.startDate.toISOString(), endAt: block.endDate.toISOString(), reason: block.reason,
    source: block.source, createdAt: block.createdAt.toISOString()
  };
}

export function priceOverrideResponse(rule: PriceRule) {
  return {
    id: rule.id, propertyId: rule.propertyId,
    startDate: rule.startDate ? lagosDate(rule.startDate) : null,
    endDate: rule.endDate ? lagosDate(rule.endDate) : null,
    label: rule.label, nightlyPriceKobo: Number(rule.nightlyPriceKobo), createdAt: rule.createdAt.toISOString()
  };
}

/** Keep audit entries focused on changed configuration, with JSON-safe integer money. */
export function configurationChanges(before: Prisma.InputJsonObject, after: Prisma.InputJsonObject) {
  const oldValues: Record<string, Prisma.InputJsonValue | null | undefined> = {};
  const newValues: Record<string, Prisma.InputJsonValue | null | undefined> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldValues[key] = before[key];
      newValues[key] = after[key];
    }
  }
  return { before: oldValues, after: newValues };
}
