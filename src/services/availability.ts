import { blocksAvailability, type BookingState } from './booking-state.js';

export type DateRange = { checkIn: Date; checkOut: Date };
export type OccupyingRange = DateRange & {
  status: BookingState;
  holdExpiresAt?: Date | null;
};

/** Short-let ranges are [check-in, check-out): checkout day is not an occupied night. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.checkIn.getTime() < b.checkOut.getTime() && b.checkIn.getTime() < a.checkOut.getTime();
}

export function rangeBlocks(range: OccupyingRange, now = new Date()): boolean {
  return blocksAvailability(range.status, range.holdExpiresAt, now);
}

export function isDateRangeAvailable(
  requested: DateRange,
  existing: OccupyingRange[],
  blocks: DateRange[] = [],
  now = new Date()
): boolean {
  if (!Number.isFinite(requested.checkIn.getTime()) || !Number.isFinite(requested.checkOut.getTime()) ||
      requested.checkOut.getTime() <= requested.checkIn.getTime()) return false;
  if (blocks.some((block) => rangesOverlap(requested, block))) return false;
  return !existing.some((range) => rangeBlocks(range, now) && rangesOverlap(requested, range));
}
