export const BOOKING_STATES = [
  'REQUESTED', 'HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED',
  'PAYMENT_REVIEW', 'PAID_CONFLICT', 'REFUND_PENDING', 'REFUNDED',
  'VERIFICATION_PENDING', 'REFUND_DUE'
] as const;

export type BookingState = typeof BOOKING_STATES[number];

const transitions: Record<BookingState, readonly BookingState[]> = {
  REQUESTED: ['HELD', 'CANCELLED'],
  HELD: ['CONFIRMED', 'EXPIRED', 'CANCELLED', 'PAYMENT_REVIEW', 'PAID_CONFLICT', 'VERIFICATION_PENDING'],
  CONFIRMED: ['CANCELLED', 'REFUND_DUE'],
  EXPIRED: ['PAID_CONFLICT'],
  CANCELLED: [],
  // Cancellation from review is restricted to the payment service's proven-unpaid resolution.
  PAYMENT_REVIEW: ['CONFIRMED', 'PAID_CONFLICT', 'REFUND_DUE', 'CANCELLED'],
  PAID_CONFLICT: ['REFUND_PENDING', 'REFUNDED'],
  REFUND_PENDING: ['REFUNDED', 'REFUND_DUE'],
  REFUNDED: [],
  VERIFICATION_PENDING: ['CONFIRMED', 'EXPIRED', 'PAYMENT_REVIEW', 'PAID_CONFLICT', 'CANCELLED'],
  REFUND_DUE: ['REFUND_PENDING', 'CANCELLED']
};

export class InvalidBookingTransitionError extends Error {
  constructor(from: BookingState, to: BookingState) {
    super(`Booking transition ${from} -> ${to} is not allowed`);
    this.name = 'InvalidBookingTransitionError';
  }
}

export function canTransition(from: BookingState, to: BookingState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: BookingState, to: BookingState): void {
  if (!canTransition(from, to)) throw new InvalidBookingTransitionError(from, to);
}

/** Only this state permits customer-facing language that says a booking is confirmed. */
export function mayTellGuestConfirmed(state: BookingState): boolean {
  return state === 'CONFIRMED';
}

/** Dates stay blocked while payment outcome is uncertain or under review. */
export function blocksAvailability(state: BookingState, holdExpiresAt?: Date | null, now = new Date()): boolean {
  if (state === 'HELD') return Boolean(holdExpiresAt && holdExpiresAt.getTime() > now.getTime());
  return ['CONFIRMED', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING'].includes(state);
}
