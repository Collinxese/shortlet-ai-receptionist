import test from 'node:test';
import assert from 'node:assert/strict';
import { isDateRangeAvailable, rangesOverlap } from '../src/services/availability.js';

const d = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`);

test('checkout day is not an occupied night', () => {
  assert.equal(rangesOverlap({ checkIn: d(10), checkOut: d(12) }, { checkIn: d(12), checkOut: d(14) }), false);
});

test('active holds and confirmed bookings block overlapping dates', () => {
  const requested = { checkIn: d(10), checkOut: d(12) };
  assert.equal(isDateRangeAvailable(requested, [{ ...requested, status: 'CONFIRMED' }], [], d(1)), false);
  assert.equal(isDateRangeAvailable(requested, [{ ...requested, status: 'HELD', holdExpiresAt: d(20) }], [], d(1)), false);
});

test('expired holds do not block, but an operator block does', () => {
  const requested = { checkIn: d(10), checkOut: d(12) };
  assert.equal(isDateRangeAvailable(requested, [{ ...requested, status: 'HELD', holdExpiresAt: d(5) }], [], d(6)), true);
  assert.equal(isDateRangeAvailable(requested, [], [{ checkIn: d(11), checkOut: d(13) }], d(6)), false);
});
