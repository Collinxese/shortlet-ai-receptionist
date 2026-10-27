import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, lagosDayStart, lagosMidnight } from '../src/services/calendar.js';
import { availabilityQuery, createPriceOverrideBody } from '../src/services/property-validation.js';
import { BOOKING_STATES, blocksAvailability } from '../src/services/booking-state.js';
import { nightlyPrices } from '../src/services/pricing.js';

test('stored Lagos day normalization is independent of request date bounds and does not mutate input', () => {
  for (const date of ['1999-12-31', '2000-01-01', '2199-12-31', '2200-01-01']) {
    const input = new Date(`${date}T14:30:00+01:00`);
    const original = input.toISOString();
    assert.equal(lagosDayStart(input).toISOString(), new Date(`${date}T00:00:00+01:00`).toISOString());
    assert.equal(input.toISOString(), original);
  }
  assert.equal(calendarDate.safeParse('1999-12-31').success, false);
  assert.equal(calendarDate.safeParse('2200-01-01').success, false);
});

test('the 366-night maximum accepts the exact boundary and rejects 367 nights and timestamp inputs', () => {
  assert.equal(availabilityQuery.safeParse({ checkIn: '2028-01-01', checkOut: '2029-01-01' }).success, true);
  assert.equal(availabilityQuery.safeParse({ checkIn: '2028-01-01', checkOut: '2029-01-02' }).success, false);
  for (const checkOut of ['2028-01-01', '2027-12-31', '2028-01-02T00:00:00+01:00', '2028-02-30']) {
    assert.equal(availabilityQuery.safeParse({ checkIn: '2028-01-01', checkOut }).success, false);
  }
});

test('all schema booking states follow the existing occupancy policy and expiry is strictly in the future', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const blocking = new Set(['CONFIRMED', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING']);
  for (const state of BOOKING_STATES) {
    if (state !== 'HELD') assert.equal(blocksAvailability(state, null, now), blocking.has(state), state);
  }
  assert.equal(blocksAvailability('HELD', new Date(now.getTime() + 1), now), true);
  assert.equal(blocksAvailability('HELD', now, now), false);
  assert.equal(blocksAvailability('HELD', new Date(now.getTime() - 1), now), false);
  assert.equal(blocksAvailability('HELD', null, now), false);
});

test('odd kobo amounts and the maximum permitted price serialize exactly across weekend and override nights', () => {
  const rates = nightlyPrices('2026-11-05', '2026-11-09', {
    baseNightlyPriceKobo: 10001n, weekendNightlyPriceKobo: 99999999999n
  }, [{ id: 'override', startDate: lagosMidnight('2026-11-07'), endDate: lagosMidnight('2026-11-08'),
    dayOfWeek: null, priority: 0, nightlyPriceKobo: 100000000000n }]);
  assert.deepEqual(rates.map((rate) => rate.nightlyPriceKobo), [10001, 99999999999, 100000000000, 10001]);
  assert.ok(rates.every((rate) => Number.isSafeInteger(rate.nightlyPriceKobo)));
  for (const nightlyPriceKobo of [0, -1, 10001.5, 100000000001, Number.MAX_SAFE_INTEGER, '10001', null]) {
    assert.equal(createPriceOverrideBody.safeParse({ startDate: '2026-11-10', endDate: '2026-11-12', label: 'Test', nightlyPriceKobo }).success, false);
  }
});
