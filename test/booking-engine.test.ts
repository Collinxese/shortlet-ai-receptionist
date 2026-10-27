import test from 'node:test';
import assert from 'node:assert/strict';
import type { PriceRule } from '@prisma/client';
import { bookingBody, guestPhone, idempotencyKey } from '../src/services/booking-validation.js';
import { bookingQuote } from '../src/services/booking-quote.js';
import { createPropertyBody } from '../src/services/property-validation.js';
import type { PropertyRecord } from '../src/services/property-data.js';
import { lagosMidnight } from '../src/services/calendar.js';

const now = new Date('2026-10-25T12:00:00Z');
function property(patch: Partial<PropertyRecord> = {}): PropertyRecord {
  return { ...createPropertyBody.parse({ name: 'Room', area: 'Lekki', bedrooms: 1, bathrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001 }),
    id: 'property', tenantId: 'tenant', currency: 'NGN', createdAt: now, updatedAt: now,
    baseNightlyPriceKobo: 10001n, weekendNightlyPriceKobo: 20003n, cleaningFeeKobo: 101n,
    earlyCheckInFeeKobo: null, lateCheckOutFeeKobo: null,
    otherFees: [{ id: 'fee', tenantId: 'tenant', propertyId: 'property', label: 'Parking', amountKobo: 103n }], ...patch };
}
const input = { propertyId: 'c' + 'a'.repeat(24), checkIn: '2026-11-05', checkOut: '2026-11-09', guestName: 'Guest', guestPhone: '08012345678', guestCount: 2 };

test('booking inputs normalize Nigerian phones and reject forged prices, tenant, state and payment claims', () => {
  assert.equal(guestPhone.parse('0801 234 5678'), '+2348012345678');
  assert.equal(guestPhone.parse('+234 (801) 234-5678'), '+2348012345678');
  for (const patch of [{ tenantId: 'foreign' }, { status: 'CONFIRMED' }, { quoteTotalKobo: 1 }, { paid: true },
    { guestName: '' }, { guestPhone: '2348012345678' }, { guestCount: 1.1 }, { guestCount: 0 },
    { checkIn: '2026-02-29' }, { checkIn: '2026-11-09' }, { checkIn: '2026-11-10' }, { checkIn: '2026-11-05T00:00:00Z' },
    { checkIn: '2028-01-01', checkOut: '2029-01-02' }]) assert.equal(bookingBody.safeParse({ ...input, ...patch }).success, false, JSON.stringify(patch));
  assert.equal(bookingBody.safeParse({ ...input, checkIn: '2028-01-01', checkOut: '2029-01-01' }).success, true);
  assert.equal(idempotencyKey.safeParse('short').success, false);
  assert.equal(idempotencyKey.safeParse('valid-key-001').success, true);
});

test('quote prices every occupied night, applies priority overrides and adds per-stay fees exactly', () => {
  const rules: PriceRule[] = [{ id: 'rule', tenantId: 'tenant', propertyId: 'property', label: 'Event',
    startDate: lagosMidnight('2026-11-07'), endDate: lagosMidnight('2026-11-08'),
    nightlyPriceKobo: 30007n, priority: 0, dayOfWeek: null, createdAt: now }];
  const quote = bookingQuote(property(), rules, input.checkIn, input.checkOut, 2, now);
  assert.deepEqual(quote.snapshot.nightly.map((night) => night.nightlyPriceKobo), [10001, 20003, 30007, 10001]);
  assert.equal(quote.total, 70216n);
  assert.equal(quote.snapshot.totalKobo, 70216);
  assert.equal(quote.snapshot.feeTotalKobo, 204);
  assert.equal(quote.snapshot.earlyLateOptionsApplied, false);
  const maximum = bookingQuote(property({ baseNightlyPriceKobo: 100_000_000_000n, weekendNightlyPriceKobo: null, cleaningFeeKobo: 0n, otherFees: [] }), [], '2028-01-01', '2029-01-01', 1, now);
  assert.equal(maximum.total, 36_600_000_000_000n);
  assert.ok(Number.isSafeInteger(maximum.snapshot.totalKobo));
});

test('quotes fail clearly for invalid configuration, inactive properties, minimum stay and capacity', () => {
  for (const [patch, code] of [
    [{ baseNightlyPriceKobo: null }, 'PRICING_INVALID'], [{ baseNightlyPriceKobo: 0n }, 'PRICING_INVALID'],
    [{ weekendNightlyPriceKobo: -1n }, 'PRICING_INVALID'], [{ cleaningFeeKobo: -1n }, 'PRICING_INVALID'],
    [{ currency: 'USD' }, 'PRICING_INVALID'], [{ standardCheckIn: '25:00' }, 'PRICING_INVALID'],
    [{ isActive: false }, 'PROPERTY_INACTIVE'], [{ minimumStayNights: 5 }, 'MINIMUM_STAY_NOT_MET'],
    [{ maxGuests: 1 }, 'GUEST_CAPACITY_EXCEEDED']
  ] as const) assert.throws(() => bookingQuote(property(patch as Partial<PropertyRecord>), [], input.checkIn, input.checkOut, 2, now),
    (error: unknown) => (error as { code?: string }).code === code);
});
