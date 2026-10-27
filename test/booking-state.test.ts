import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, blocksAvailability, canTransition, mayTellGuestConfirmed } from '../src/services/booking-state.js';

test('only CONFIRMED permits a confirmation message', () => {
  assert.equal(mayTellGuestConfirmed('CONFIRMED'), true);
  assert.equal(mayTellGuestConfirmed('HELD'), false);
  assert.equal(mayTellGuestConfirmed('VERIFICATION_PENDING'), false);
});

test('uncertain payment and review states keep dates blocked', () => {
  assert.equal(blocksAvailability('VERIFICATION_PENDING'), true);
  assert.equal(blocksAvailability('PAYMENT_REVIEW'), true);
  assert.equal(blocksAvailability('PAID_CONFLICT'), false);
});

test('expired holds do not block dates based on state alone', () => {
  assert.equal(blocksAvailability('HELD', new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z')), false);
  assert.equal(blocksAvailability('HELD', new Date('2030-01-01T00:00:00Z'), new Date('2029-01-01T00:00:00Z')), true);
});

test('invalid state transitions are rejected', () => {
  assert.equal(canTransition('HELD', 'CONFIRMED'), true);
  assert.equal(canTransition('EXPIRED', 'CONFIRMED'), false);
  assert.throws(() => assertTransition('EXPIRED', 'CONFIRMED'), /not allowed/);
});
