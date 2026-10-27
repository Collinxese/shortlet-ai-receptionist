import { z } from 'zod';
import { availabilityQuery } from './property-validation.js';
import { id, name } from './validation.js';
import { BOOKING_STATES } from './booking-state.js';

export function normalizeGuestPhone(value: string) {
  const cleaned = value.trim().replace(/[ ()-]/g, '');
  return /^0\d{10}$/.test(cleaned) ? `+234${cleaned.slice(1)}` : cleaned;
}
export const guestPhone = z.string().trim().max(40).transform(normalizeGuestPhone).pipe(z.string().regex(/^\+[1-9]\d{7,14}$/));
export const bookingBody = availabilityQuery.safeExtend({
  propertyId: id, guestName: name, guestPhone, guestCount: z.number().int().min(1).max(1000)
});
export const bookingQuoteBody = availabilityQuery.safeExtend({ propertyId: id, guestCount: z.number().int().min(1).max(1000) });
export const bookingParams = z.strictObject({ bookingId: id });
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export const cancelBookingBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export const bookingListQuery = z.strictObject({
  propertyId: id.optional(), status: z.enum(BOOKING_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0)
});
