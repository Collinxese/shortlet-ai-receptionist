import { z } from 'zod';
import { calendarDate, calendarRange, nightsBetween, MAX_STAY_NIGHTS } from './calendar.js';
import { id, name } from './validation.js';

export const MAX_MONEY_KOBO = 100_000_000_000;
export const propertySearchQuery = z.strictObject({ area: name.optional(), guestCount: z.number().int().min(1).max(1000).optional(),
  bedrooms: z.number().int().min(0).max(100).optional(), amenities: z.array(name).max(10).optional() });
export const moneyKobo = z.number().int().min(0).max(MAX_MONEY_KOBO);
const nightlyPrice = moneyKobo.refine((value) => value > 0);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable();
const fee = z.strictObject({ label: z.string().trim().min(1).max(80), amountKobo: moneyKobo });
const otherFees = z.array(fee).max(20).refine((fees) => new Set(fees.map((item) => item.label.toLowerCase())).size === fees.length);
const amenities = z.array(z.string().trim().min(1).max(80)).max(50)
  .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length);

export const propertyFields = z.strictObject({
  name, area: name, address: optionalText(500), description: optionalText(5000),
  bedrooms: z.number().int().min(0).max(100), bathrooms: z.number().int().min(0).max(100),
  maxGuests: z.number().int().min(1).max(1000), amenities,
  baseNightlyPriceKobo: nightlyPrice, weekendNightlyPriceKobo: nightlyPrice.nullable(),
  cleaningFeeKobo: moneyKobo, otherFees,
  minimumStayNights: z.number().int().min(1).max(MAX_STAY_NIGHTS),
  standardCheckIn: clockTime, standardCheckOut: clockTime,
  earlyCheckInAllowed: z.boolean(), earlyCheckInFrom: clockTime.nullable(),
  earlyCheckInFeeKobo: moneyKobo.nullable(), earlyCheckInRules: optionalText(1000),
  lateCheckOutAllowed: z.boolean(), lateCheckOutUntil: clockTime.nullable(),
  lateCheckOutFeeKobo: moneyKobo.nullable(), lateCheckOutRules: optionalText(1000),
  cancellationPolicy: optionalText(5000), refundPolicy: optionalText(5000), isActive: z.boolean()
});
export const propertyTimes = propertyFields.pick({
  standardCheckIn: true, standardCheckOut: true, earlyCheckInFrom: true, lateCheckOutUntil: true
}).refine((value) =>
  (!value.earlyCheckInFrom || value.earlyCheckInFrom < value.standardCheckIn) &&
  (!value.lateCheckOutUntil || value.lateCheckOutUntil > value.standardCheckOut));
export const completeProperty = propertyFields.refine((value) => propertyTimes.safeParse({
  standardCheckIn: value.standardCheckIn, standardCheckOut: value.standardCheckOut,
  earlyCheckInFrom: value.earlyCheckInFrom, lateCheckOutUntil: value.lateCheckOutUntil
}).success);

export const createPropertyBody = propertyFields.extend({
  address: propertyFields.shape.address.default(null), description: propertyFields.shape.description.default(null),
  amenities: amenities.default([]), weekendNightlyPriceKobo: nightlyPrice.nullable().default(null),
  cleaningFeeKobo: moneyKobo.default(0), otherFees: otherFees.default([]),
  minimumStayNights: propertyFields.shape.minimumStayNights.default(1),
  standardCheckIn: clockTime.default('12:00'), standardCheckOut: clockTime.default('12:00'),
  earlyCheckInAllowed: z.boolean().default(false), earlyCheckInFrom: clockTime.nullable().default(null),
  earlyCheckInFeeKobo: moneyKobo.nullable().default(null), earlyCheckInRules: optionalText(1000).default(null),
  lateCheckOutAllowed: z.boolean().default(false), lateCheckOutUntil: clockTime.nullable().default(null),
  lateCheckOutFeeKobo: moneyKobo.nullable().default(null), lateCheckOutRules: optionalText(1000).default(null),
  cancellationPolicy: optionalText(5000).default(null), refundPolicy: optionalText(5000).default(null),
  isActive: z.boolean().default(true)
}).pipe(completeProperty);
export const updatePropertyBody = propertyFields.partial().refine((value) => Object.keys(value).length > 0);
export type PropertyInput = z.infer<typeof completeProperty>;

export const propertyParams = z.strictObject({ propertyId: id });
export const blockParams = propertyParams.extend({ blockId: id });
export const priceRuleParams = propertyParams.extend({ ruleId: id });
export const propertyListQuery = z.strictObject({
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
});
export const calendarListQuery = z.strictObject({
  startDate: calendarDate.optional(), endDate: calendarDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
}).refine(({ startDate, endDate }) => (!startDate && !endDate) ||
  Boolean(startDate && endDate && calendarRange.safeParse({ startDate, endDate }).success));
export const validListRange = (value: { startDate?: string; endDate?: string }) =>
  value.startDate && value.endDate ? calendarRange.parse({ startDate: value.startDate, endDate: value.endDate }) : undefined;
export const createBlockBody = calendarRange.safeExtend({ reason: z.string().trim().min(1).max(500) });
export const createPriceOverrideBody = calendarRange.safeExtend({ label: name, nightlyPriceKobo: nightlyPrice });
export const availabilityQuery = z.strictObject({ checkIn: calendarDate, checkOut: calendarDate })
  .refine(({ checkIn, checkOut }) => {
    if (!calendarDate.safeParse(checkIn).success || !calendarDate.safeParse(checkOut).success) return false;
    const nights = nightsBetween(checkIn, checkOut);
    return nights > 0 && nights <= MAX_STAY_NIGHTS;
  });
