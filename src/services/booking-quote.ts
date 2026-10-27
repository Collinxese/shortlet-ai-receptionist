import type { PriceRule } from '@prisma/client';
import type { PropertyRecord } from './property-data.js';
import { propertyConfiguration } from './property-data.js';
import { nightlyPrices } from './pricing.js';
import { nightsBetween } from './calendar.js';
import { propertyTimes } from './property-validation.js';
import { HttpError } from './errors.js';
import { createHash } from 'node:crypto';

/** Compare consented backend terms while excluding the time of calculation. */
export function quoteTermsHash(snapshot: Record<string, unknown>) {
  const { quotedAt: _quotedAt, ...terms } = snapshot;
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,stable(item)])) : value;
  return createHash('sha256').update(JSON.stringify(stable(terms))).digest('hex');
}

const MAX_PRICE = 100_000_000_000n;
function validMoney(value: unknown, positive = false): asserts value is bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > MAX_PRICE) throw new HttpError(409, 'PRICING_INVALID');
}
function integer(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(409, 'PRICING_INVALID');
  return Number(value);
}

/** BigInt arithmetic; conversion to JSON numbers happens only after exact range checks. */
export function bookingQuote(property: PropertyRecord, rules: PriceRule[], checkIn: string, checkOut: string, guestCount: number, now: Date) {
  if (!property.isActive) throw new HttpError(409, 'PROPERTY_INACTIVE');
  const nights = nightsBetween(checkIn, checkOut);
  if (!Number.isInteger(property.minimumStayNights) || property.minimumStayNights < 1 || property.minimumStayNights > 366 ||
    !Number.isInteger(property.maxGuests) || property.maxGuests < 1 || property.currency !== 'NGN' ||
    !propertyTimes.safeParse({ standardCheckIn: property.standardCheckIn, standardCheckOut: property.standardCheckOut,
      earlyCheckInFrom: property.earlyCheckInFrom, lateCheckOutUntil: property.lateCheckOutUntil }).success) throw new HttpError(409, 'PRICING_INVALID');
  if (nights < property.minimumStayNights) throw new HttpError(409, 'MINIMUM_STAY_NOT_MET');
  if (guestCount > property.maxGuests) throw new HttpError(409, 'GUEST_CAPACITY_EXCEEDED');
  validMoney(property.baseNightlyPriceKobo, true);
  if (property.weekendNightlyPriceKobo !== null) validMoney(property.weekendNightlyPriceKobo, true);
  validMoney(property.cleaningFeeKobo);
  for (const value of [property.earlyCheckInFeeKobo, property.lateCheckOutFeeKobo]) if (value !== null) validMoney(value);
  for (const fee of property.otherFees) validMoney(fee.amountKobo);
  for (const rule of rules) {
    validMoney(rule.nightlyPriceKobo, true);
    if ((rule.dayOfWeek !== null && (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 0 || rule.dayOfWeek > 6)) ||
      (rule.startDate && rule.endDate && rule.startDate >= rule.endDate)) throw new HttpError(409, 'PRICING_INVALID');
  }
  const nightly = nightlyPrices(checkIn, checkOut, property, rules);
  const nightlyTotal = nightly.reduce((total, night) => total + BigInt(night.nightlyPriceKobo), 0n);
  const fees = [{ label: 'Cleaning', amountKobo: integer(property.cleaningFeeKobo) },
    ...property.otherFees.map((fee) => ({ label: fee.label, amountKobo: integer(fee.amountKobo) }))];
  const feeTotal = fees.reduce((total, fee) => total + BigInt(fee.amountKobo), 0n);
  const total = nightlyTotal + feeTotal;
  const snapshot = {
    version: 1, quotedAt: now.toISOString(), timezone: 'Africa/Lagos', currency: 'NGN', checkIn, checkOut, nights, guestCount,
    property: { id: property.id, updatedAt: property.updatedAt.toISOString(), ...propertyConfiguration(property) },
    priceRules: rules.sort((a, b) => a.id.localeCompare(b.id)).map((rule) => ({
      id: rule.id, label: rule.label, startDate: rule.startDate?.toISOString() ?? null, endDate: rule.endDate?.toISOString() ?? null,
      dayOfWeek: rule.dayOfWeek, priority: rule.priority, nightlyPriceKobo: integer(rule.nightlyPriceKobo)
    })),
    nightly, fees, nightlyTotalKobo: integer(nightlyTotal), feeTotalKobo: integer(feeTotal), totalKobo: integer(total),
    // Early/late options are policies, never automatically charged or approved.
    earlyLateOptionsApplied: false
  };
  return { total, snapshot };
}
