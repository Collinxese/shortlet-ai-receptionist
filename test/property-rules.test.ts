import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, calendarRange, lagosDate, lagosMidnight, nightsBetween } from '../src/services/calendar.js';
import { availabilityQuery, calendarListQuery, createBlockBody, createPropertyBody, updatePropertyBody } from '../src/services/property-validation.js';
import { nightlyPrices } from '../src/services/pricing.js';
import { hasPermission } from '../src/services/authorization.js';

const property = { name: 'Test', area: 'Lekki', bedrooms: 1, bathrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 5_000_000 };

test('calendar dates are strict civil dates and midnight is stored in UTC for Africa/Lagos', () => {
  assert.equal(lagosMidnight('2026-11-10').toISOString(), '2026-11-09T23:00:00.000Z');
  assert.equal(lagosDate(lagosMidnight('2026-11-10')), '2026-11-10');
  assert.equal(nightsBetween('2026-11-10', '2026-11-12'), 2);
  assert.equal(nightsBetween('2028-02-28', '2028-03-01'), 2);
  for (const date of ['2026-02-29', '2026-04-31', '2026-2-01', '2026-11-10T00:00:00Z', '1999-12-31']) {
    assert.equal(calendarDate.safeParse(date).success, false, date);
    assert.equal(calendarRange.safeParse({ startDate: date, endDate: '2027-01-01' }).success, false);
  }
});

test('calendar intervals must be positive, at most 366 nights, and use both bounds', () => {
  for (const endDate of ['2026-11-10', '2026-11-09', '2028-01-01']) {
    assert.equal(createBlockBody.safeParse({ startDate: '2026-11-10', endDate, reason: 'Test' }).success, false);
    assert.equal(availabilityQuery.safeParse({ checkIn: '2026-11-10', checkOut: endDate }).success, false);
  }
  assert.equal(calendarListQuery.safeParse({ startDate: '2026-11-10' }).success, false);
  assert.equal(calendarListQuery.safeParse({ startDate: '2026-11-10', endDate: '2026-11-12', limit: '10' }).success, true);
  assert.equal(calendarRange.safeParse({ startDate: '2028-01-01', endDate: '2029-01-01' }).success, true);
});

test('property configuration validates integer money, dimensions, clocks and protected fields', () => {
  assert.equal(createPropertyBody.parse(property).cleaningFeeKobo, 0);
  for (const patch of [
    { baseNightlyPriceKobo: 1.5 }, { baseNightlyPriceKobo: 0 }, { baseNightlyPriceKobo: '5000' },
    { baseNightlyPriceKobo: 100_000_000_001 }, { cleaningFeeKobo: -1 }, { bedrooms: -1 }, { bathrooms: 1.5 },
    { maxGuests: 0 }, { minimumStayNights: 367 }, { standardCheckIn: '24:00' },
    { earlyCheckInFrom: '13:00' }, { lateCheckOutUntil: '11:00' },
    { otherFees: [{ label: 'Parking', amountKobo: 1 }, { label: 'parking', amountKobo: 2 }] },
    { amenities: ['Wi-Fi', 'wi-fi'] }, { isActive: 'false' }, { tenantId: 'forged' }, { currency: 'USD' }, { role: 'OWNER' }
  ]) assert.equal(createPropertyBody.safeParse({ ...property, ...patch }).success, false, JSON.stringify(patch));
  assert.equal(updatePropertyBody.safeParse({}).success, false);
  assert.equal(updatePropertyBody.safeParse({ tenantId: 'forged' }).success, false);
});

test('nightly prices use weekday rates, Friday/Saturday weekend rates and half-open overrides', () => {
  const prices = nightlyPrices('2026-11-05', '2026-11-09', { baseNightlyPriceKobo: 10000n, weekendNightlyPriceKobo: 20000n }, [{
    id: 'rule', startDate: lagosMidnight('2026-11-07'), endDate: lagosMidnight('2026-11-08'),
    nightlyPriceKobo: 30000n, dayOfWeek: null, priority: 0
  }]);
  assert.deepEqual(prices.map((item) => [item.date, item.nightlyPriceKobo]), [
    ['2026-11-05', 10000], ['2026-11-06', 20000], ['2026-11-07', 30000], ['2026-11-08', 10000]
  ]);
  assert.equal(nightlyPrices('2026-11-06', '2026-11-07', { baseNightlyPriceKobo: 10000n, weekendNightlyPriceKobo: null }, [])[0]?.nightlyPriceKobo, 10000);
});

test('only owners and managers may configure properties, pricing and blocks', () => {
  for (const role of ['OWNER', 'MANAGER'] as const) {
    for (const permission of ['properties:write', 'pricing:write', 'availability:write'] as const) assert.equal(hasPermission(role, permission), true);
  }
  assert.equal(hasPermission('RECEPTIONIST', 'properties:read'), true);
  for (const permission of ['properties:write', 'pricing:write', 'availability:write'] as const) assert.equal(hasPermission('RECEPTIONIST', permission), false);
});
