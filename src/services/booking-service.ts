import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type Booking } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { hasPermission, type Permission } from './authorization.js';
import { HttpError } from './errors.js';
import { bookingBody, bookingListQuery, cancelBookingBody, idempotencyKey, normalizeGuestPhone, bookingQuoteBody } from './booking-validation.js';
import { bookingQuote, quoteTermsHash } from './booking-quote.js';
import { asDateRange, lagosDate } from './calendar.js';
import { isDateRangeAvailable } from './availability.js';
import { assertTransition, mayTellGuestConfirmed, type BookingState } from './booking-state.js';
import { HoldIntegrityError, integrityAlert, occupyingBookings, tenantProperty } from './occupancy.js';

export const HOLD_MINUTES = 60;
export const HOLD_EXTENSION_MINUTES = 15;
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 10_000 };
export type PaymentActor = { kind: 'USER'; userId: string } | { kind: 'PROVIDER' };

export function paymentAudit(tx: Prisma.TransactionClient, tenantId: string, actor: PaymentActor,
  action: string, entityType: string, entityId: string, after: Prisma.InputJsonObject) {
  return tx.auditLog.create({ data: { tenantId, actorId: actor.kind === 'USER' ? actor.userId : null,
    actorType: actor.kind === 'USER' ? 'USER' : 'PROVIDER', action, entityType, entityId, after } });
}

function response(booking: Booking, now: Date) {
  const expired = booking.status === 'HELD' && booking.holdExpiresAt !== null && booking.holdExpiresAt <= now;
  return {
    id: booking.id, reference: booking.reference, propertyId: booking.propertyId,
    guestName: booking.guestName, guestPhone: booking.guestPhone, guestCount: booking.guestCount,
    checkIn: lagosDate(booking.checkIn), checkOut: lagosDate(booking.checkOut), timezone: 'Africa/Lagos',
    status: booking.status, effectiveStatus: expired ? 'EXPIRED' : booking.status,
    confirmed: mayTellGuestConfirmed(booking.status), holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
    holdStartedAt: booking.holdStartedAt?.toISOString() ?? null, holdExtensionCount: booking.holdExtensionCount,
    // Legacy totals outside JSON's exact integer range are decimal strings.
    quoteTotalKobo: booking.quoteTotalKobo <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(booking.quoteTotalKobo) : booking.quoteTotalKobo.toString(),
    currency: booking.currency, quoteSnapshot: booking.quoteSnapshot, legacyQuote: booking.quoteSnapshot === null,
    cancellationReason: booking.cancellationReason, version: booking.version,
    createdAt: booking.createdAt.toISOString(), updatedAt: booking.updatedAt.toISOString()
  };
}

/** Narrow tenant-scoped business service; no client-provided Prisma arguments or states. */
export class BookingService {
  private readonly tenantId: string;

  /** Internal payment operations run inside the caller's READ COMMITTED transaction. */
  static async lockPayment(tx: Prisma.TransactionClient, tenantId: string, paymentId: string) {
    const initial = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
    if (!initial) throw new HttpError(404, 'NOT_FOUND');
    const first = await tx.booking.findFirst({ where: { id: initial.bookingId, tenantId } });
    if (!first) throw new HttpError(404, 'NOT_FOUND');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + normalizeGuestPhone(first.guestPhone)}, 42))::text`;
    const property = await tenantProperty(tx, tenantId, first.propertyId, true);
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const payment = await tx.payment.findFirstOrThrow({ where: { id: paymentId, tenantId } });
    const booking = await tx.booking.findFirstOrThrow({ where: { id: payment.bookingId, tenantId } });
    return { payment, booking, property };
  }

  static async paymentReview(tx: Prisma.TransactionClient, tenantId: string, paymentId: string,
    actor: PaymentActor, pending: boolean, paid = false, now = new Date()) {
    const { booking, property } = await BookingService.lockPayment(tx, tenantId, paymentId);
    let target: BookingState | undefined;
    if (paid && (booking.status === 'EXPIRED' || (booking.status === 'HELD' && booking.holdExpiresAt && booking.holdExpiresAt <= now))) target = 'PAID_CONFLICT';
    else if (property.isActive && booking.status === 'HELD' && booking.holdExpiresAt && booking.holdExpiresAt > now) target = pending ? 'VERIFICATION_PENDING' : 'PAYMENT_REVIEW';
    else if (property.isActive && !pending && booking.status === 'VERIFICATION_PENDING') target = 'PAYMENT_REVIEW';
    if (booking.status === 'HELD' && !booking.holdExpiresAt) {
      await paymentAudit(tx, tenantId, actor, 'booking.integrity_review_required', 'Property', booking.propertyId, { issue: 'HELD_WITHOUT_EXPIRY' });
    }
    if (target) {
      assertTransition(booking.status, target);
      // A savepoint preserves receipt/review records if an existing calendar conflict prevents review occupancy.
      await tx.$executeRawUnsafe('SAVEPOINT payment_review');
      try {
        await tx.booking.update({ where: { id: booking.id, tenantId, version: booking.version }, data: { status: target, version: { increment: 1 } } });
        await paymentAudit(tx, tenantId, actor, 'booking.payment_review', 'Booking', booking.id, { from: booking.status, status: target, paymentId });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_review');
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT payment_review');
        if (!BookingService.isOccupancyConflict(error)) throw error;
      }
    }
  }

  private static isOccupancyConflict(error: unknown) {
    return (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError) &&
      /Booking_occupancy_conflict|Booking_durable_no_overlap|Booking_block_conflict|Occupancy_review_required|Payment_confirmation_required/.test(error.message);
  }

  static async closeUnpaidReview(tx: Prisma.TransactionClient, tenantId: string, paymentId: string, actor: PaymentActor, reason: string) {
    const { booking } = await BookingService.lockPayment(tx, tenantId, paymentId);
    if (!['HELD', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING'].includes(booking.status)) throw new HttpError(409, 'BOOKING_REVIEW_REQUIRED');
    // A pending second attempt or any recorded receipt forbids releasing these dates.
    const uncertain = await tx.payment.count({ where: { tenantId, bookingId: booking.id,
      OR: [{ status: { not: 'FAILED' } }, { receivedAmountKobo: { not: null } }, { verifiedAt: { not: null } }, { appliedAt: { not: null } }] } });
    if (uncertain) throw new HttpError(409, 'PAYMENT_REVIEW_REQUIRED');
    assertTransition(booking.status, 'CANCELLED');
    await tx.booking.update({ where: { id: booking.id, tenantId, version: booking.version },
      data: { status: 'CANCELLED', cancellationReason: reason, version: { increment: 1 } } });
    await paymentAudit(tx, tenantId, actor, 'booking.unpaid_review_cancelled', 'Booking', booking.id, { paymentId, reason });
  }

  static async confirmVerifiedPayment(tx: Prisma.TransactionClient, tenantId: string, paymentId: string, actor: PaymentActor, now = new Date()): Promise<string | null> {
    const { payment, booking, property } = await BookingService.lockPayment(tx, tenantId, paymentId);
    if (payment.status !== 'SUCCEEDED' || !payment.verifiedAt || payment.receivedAmountKobo !== booking.quoteTotalKobo ||
      payment.expectedAmountKobo !== booking.quoteTotalKobo || payment.currency !== booking.currency) throw new HttpError(409, 'PAYMENT_NOT_VERIFIED');
    if (booking.status === 'CONFIRMED') return booking.paymentReference === payment.reference ? null : 'DUPLICATE_PAYMENT';
    if (!['HELD', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING'].includes(booking.status)) return 'BOOKING_NOT_ELIGIBLE';
    if (!booking.holdExpiresAt) return 'OCCUPANCY_REVIEW_REQUIRED';
    if (booking.holdExpiresAt <= now) return 'HOLD_EXPIRED';
    if (!booking.quoteSnapshot) return 'LEGACY_BOOKING_REVIEW_REQUIRED';
    try {
      bookingQuote(property, [], lagosDate(booking.checkIn), lagosDate(booking.checkOut), booking.guestCount, now);
      const range = { checkIn: booking.checkIn, checkOut: booking.checkOut };
      const occupants = await occupyingBookings(tx, tenantId, property.id, range, now, booking.id);
      const blocks = await tx.availabilityBlock.findMany({ where: { tenantId, propertyId: property.id,
        startDate: { lt: range.checkOut }, endDate: { gt: range.checkIn } } });
      if (!isDateRangeAvailable(range, occupants, blocks.map((block) => ({ checkIn: block.startDate, checkOut: block.endDate })), now)) return 'DATES_UNAVAILABLE';
    } catch (error) { if (error instanceof HttpError) return error.code; throw error; }
    assertTransition(booking.status, 'CONFIRMED');
    await tx.$executeRawUnsafe('SAVEPOINT payment_confirmation');
    try {
      await tx.booking.update({ where: { id: booking.id, tenantId, version: booking.version }, data: {
        status: 'CONFIRMED', paymentReference: payment.reference,
        paymentTransactionId: payment.method === 'PAYSTACK_TEST' ? `paystack-test-${payment.providerTransactionId}` : `manual-${payment.reference}`,
        paidAt: payment.receivedAt, version: { increment: 1 }
      } });
      await tx.payment.update({ where: { id: paymentId, tenantId }, data: { appliedAt: now } });
      await paymentAudit(tx, tenantId, actor, 'booking.confirmed', 'Booking', booking.id, { paymentId, reference: payment.reference, status: 'CONFIRMED' });
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT payment_confirmation');
      return null;
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT payment_confirmation');
      if (BookingService.isOccupancyConflict(error)) return 'DATES_UNAVAILABLE';
      throw error;
    }
  }
  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext, private readonly clock = () => new Date()) {
    this.tenantId = auth.user.tenantId;
    if (!this.tenantId) throw new HttpError(401, 'UNAUTHORIZED');
  }
  private permit(permission: Permission) {
    if (!hasPermission(this.auth.user.role, permission)) throw new HttpError(403, 'FORBIDDEN');
  }
  private async record(tx: Prisma.TransactionClient, id: string) {
    const booking = await tx.booking.findFirst({ where: { id, tenantId: this.tenantId } });
    if (!booking) throw new HttpError(404, 'NOT_FOUND');
    return booking;
  }
  private async phoneLock(tx: Prisma.TransactionClient, phone: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${this.tenantId + ':' + phone}, 42))::text`;
  }
  private audit(tx: Prisma.TransactionClient, bookingId: string, action: string, after: Prisma.InputJsonObject, before?: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: { tenantId: this.tenantId, actorId: this.auth.user.id, actorType: 'USER',
      entityType: 'Booking', entityId: bookingId, action, before, after } });
  }
  private async checkCalendar(tx: Prisma.TransactionClient, propertyId: string, checkIn: string, checkOut: string, now: Date, excludeId?: string) {
    const range = asDateRange({ startDate: checkIn, endDate: checkOut });
    const bookings = await occupyingBookings(tx, this.tenantId, propertyId, range, now, excludeId);
    const blocks = await tx.availabilityBlock.findMany({ where: {
      tenantId: this.tenantId, propertyId, startDate: { lt: range.checkOut }, endDate: { gt: range.checkIn }
    }, select: { startDate: true, endDate: true } });
    if (!isDateRangeAvailable(range, bookings, blocks.map((b) => ({ checkIn: b.startDate, checkOut: b.endDate })), now)) {
      throw new HttpError(409, 'DATES_UNAVAILABLE');
    }
  }
  async quote(input: unknown) {
    this.permit('bookings:read');
    const data = bookingQuoteBody.parse(input);
    return this.db.$transaction(async (tx) => {
      const property = await tenantProperty(tx, this.tenantId, data.propertyId);
      const now = this.clock();
      await this.checkCalendar(tx, property.id, data.checkIn, data.checkOut, now);
      const range = asDateRange({ startDate: data.checkIn, endDate: data.checkOut });
      const rules = await tx.priceRule.findMany({ where: { tenantId: this.tenantId, propertyId: property.id,
        AND: [{ OR: [{ startDate: null }, { startDate: { lt: range.checkOut } }] },
          { OR: [{ endDate: null }, { endDate: { gt: range.checkIn } }] }] } });
      return bookingQuote(property, rules, data.checkIn, data.checkOut, data.guestCount, now).snapshot;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async create(kind: 'REQUESTED' | 'HELD', input: unknown, keyInput: unknown, expectedQuoteHash?: string,
    beforeMutation?: (tx: Prisma.TransactionClient) => Promise<void>, afterCreation?: (tx: Prisma.TransactionClient, bookingId: string) => Promise<void>) {
    this.permit('bookings:create');
    // Runtime guard also protects non-TypeScript internal callers.
    if (kind !== 'REQUESTED' && kind !== 'HELD') throw new HttpError(409, 'TRANSITION_UNAVAILABLE');
    const data = bookingBody.parse(input);
    const key = idempotencyKey.parse(keyInput);
    const operation = `booking.create.${kind.toLowerCase()}`;
    const inputHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.db.$transaction(async (tx) => {
      // Lock order: idempotency key, guest phone (holds), tenant property, booking.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.tenantId, operation, key])}, 43))::text`;
      await beforeMutation?.(tx);
      const existing = await tx.bookingOperation.findUnique({ where: { tenantId_operation_key: { tenantId: this.tenantId, operation, key } } });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
        if (expectedQuoteHash) {
          const original = await tx.booking.findFirstOrThrow({ where: { id: existing.bookingId, tenantId: this.tenantId } });
          if (!original.quoteSnapshot || quoteTermsHash(original.quoteSnapshot as Record<string, unknown>) !== expectedQuoteHash) throw new HttpError(409,'QUOTE_CHANGED_REVIEW_REQUIRED');
        }
        await afterCreation?.(tx,existing.bookingId);
        return existing.response;
      }
      if (kind === 'HELD') await this.phoneLock(tx, data.guestPhone);
      const property = await tenantProperty(tx, this.tenantId, data.propertyId, true);
      const now = this.clock(); // Evaluate expiry AFTER waiting for locks.
      const range = asDateRange({ startDate: data.checkIn, endDate: data.checkOut });
      const rules = await tx.priceRule.findMany({ where: { tenantId: this.tenantId, propertyId: property.id,
        AND: [{ OR: [{ startDate: null }, { startDate: { lt: range.checkOut } }] },
          { OR: [{ endDate: null }, { endDate: { gt: range.checkIn } }] }] } });
      const quote = bookingQuote(property, rules, data.checkIn, data.checkOut, data.guestCount, now);
      if (expectedQuoteHash && quoteTermsHash(quote.snapshot) !== expectedQuoteHash) throw new HttpError(409, 'QUOTE_CHANGED_REVIEW_REQUIRED');
      if (kind === 'HELD') {
        // SQL normalization also covers pre-Phase-3 Nigerian local phone formats.
        const holds = await tx.$queryRaw<{ id: string; propertyId: string; holdExpiresAt: Date | null }[]>`SELECT id, "propertyId", "holdExpiresAt" FROM "Booking"
          WHERE "tenantId" = ${this.tenantId} AND booking_phone("guestPhone") = ${data.guestPhone} AND status = 'HELD'
          AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" > (${now}::timestamptz AT TIME ZONE 'UTC'))`;
        const malformed = holds.find((hold) => hold.holdExpiresAt === null);
        if (malformed) throw new HoldIntegrityError(malformed.propertyId);
        if (holds.length) throw new HttpError(409, 'GUEST_ACTIVE_HOLD');
        await this.checkCalendar(tx, property.id, data.checkIn, data.checkOut, now);
      }
      const booking = await tx.booking.create({ data: {
        tenantId: this.tenantId, propertyId: property.id, guestName: data.guestName, guestPhone: data.guestPhone,
        guestCount: data.guestCount, ...range, status: kind, quoteTotalKobo: quote.total, currency: 'NGN',
        holdStartedAt: kind === 'HELD' ? now : null,
        holdExpiresAt: kind === 'HELD' ? new Date(now.getTime() + HOLD_MINUTES * 60_000) : null,
        quoteSnapshot: quote.snapshot, policySnapshot: {
          cancellationPolicy: property.cancellationPolicy, refundPolicy: property.refundPolicy,
          standardCheckIn: property.standardCheckIn, standardCheckOut: property.standardCheckOut
        }
      } });
      await afterCreation?.(tx,booking.id);
      await this.audit(tx, booking.id, `booking.${kind === 'HELD' ? 'held' : 'requested'}`, {
        status: kind, propertyId: property.id, checkIn: data.checkIn, checkOut: data.checkOut,
        quoteTotalKobo: quote.snapshot.totalKobo, reference: booking.reference,
        holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null
      });
      const result = response(booking, now);
      await tx.bookingOperation.create({ data: { tenantId: this.tenantId, operation, key, inputHash, bookingId: booking.id, response: result } });
      return result;
    }, transactionOptions).catch((error: unknown) => integrityAlert(this.db, this.auth, data.propertyId, error));
  }
  async get(id: string) {
    this.permit('bookings:read');
    const booking = await this.record(this.db, id);
    if (booking.status === 'HELD' && booking.holdExpiresAt === null) {
      return integrityAlert(this.db, this.auth, booking.propertyId, new HttpError(409, 'OCCUPANCY_REVIEW_REQUIRED'));
    }
    return response(booking, this.clock());
  }
  async list(query: unknown) {
    this.permit('bookings:read');
    const { propertyId, status, limit, offset } = bookingListQuery.parse(query);
    if (propertyId) await tenantProperty(this.db, this.tenantId, propertyId);
    const rows = await this.db.booking.findMany({ where: { tenantId: this.tenantId, propertyId, status },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset,
      // List only operational summaries, not guest phones or full price/policy snapshots.
      select: { id: true, reference: true, propertyId: true, guestName: true, guestCount: true,
        checkIn: true, checkOut: true, status: true, holdExpiresAt: true, createdAt: true } });
    const now = this.clock();
    return { bookings: rows.map((row) => ({ ...row, checkIn: lagosDate(row.checkIn), checkOut: lagosDate(row.checkOut),
      effectiveStatus: row.status === 'HELD' && row.holdExpiresAt && row.holdExpiresAt <= now ? 'EXPIRED' : row.status,
      integrityReviewRequired: row.status === 'HELD' && !row.holdExpiresAt })), limit, offset };
  }
  private async lockedMutation(id: string, run: (tx: Prisma.TransactionClient, booking: Booking, now: Date) => Promise<Booking>) {
    const initial = await this.record(this.db, id);
    return this.db.$transaction(async (tx) => {
      await this.phoneLock(tx, normalizeGuestPhone(initial.guestPhone));
      await tenantProperty(tx, this.tenantId, initial.propertyId, true);
      const booking = await this.record(tx, id);
      if (booking.status === 'HELD' && booking.holdExpiresAt === null) throw new HttpError(409, 'OCCUPANCY_REVIEW_REQUIRED');
      const now = this.clock();
      return response(await run(tx, booking, now), now);
    }, transactionOptions).catch((error: unknown) => integrityAlert(this.db, this.auth, initial.propertyId, error));
  }
  async extend(id: string) {
    this.permit('bookings:create');
    return this.lockedMutation(id, async (tx, booking, now) => {
      if (booking.status !== 'HELD') throw new HttpError(409, 'INVALID_BOOKING_STATE');
      if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) throw new HttpError(409, 'HOLD_EXPIRED');
      if (booking.holdExtensionCount !== 0) throw new HttpError(409, 'HOLD_ALREADY_EXTENDED');
      if (booking.quoteSnapshot === null || booking.holdStartedAt === null) throw new HttpError(409, 'LEGACY_BOOKING_REVIEW_REQUIRED');
      const property = await tenantProperty(tx, this.tenantId, booking.propertyId);
      const checkIn = lagosDate(booking.checkIn), checkOut = lagosDate(booking.checkOut);
      // Validate current bookability without replacing the immutable agreed quote.
      bookingQuote(property, [], checkIn, checkOut, booking.guestCount, now);
      await this.checkCalendar(tx, property.id, checkIn, checkOut, now, booking.id);
      const holdExpiresAt = new Date(booking.holdExpiresAt.getTime() + HOLD_EXTENSION_MINUTES * 60_000);
      const updated = await tx.booking.update({ where: { id, tenantId: this.tenantId, version: booking.version, status: 'HELD' },
        data: { holdExpiresAt, holdExtensionCount: 1, version: { increment: 1 } } });
      await this.audit(tx, id, 'booking.hold_extended', { holdExpiresAt: holdExpiresAt.toISOString(), holdExtensionCount: 1 },
        { holdExpiresAt: booking.holdExpiresAt.toISOString(), holdExtensionCount: 0 });
      return updated;
    });
  }
  private async transition(tx: Prisma.TransactionClient, booking: Booking, to: BookingState, reason?: string) {
    // This phase deliberately exposes no confirmation/financial transition capability.
    if (to !== 'CANCELLED' && to !== 'EXPIRED') throw new HttpError(409, 'TRANSITION_UNAVAILABLE');
    if (!['REQUESTED', 'HELD'].includes(booking.status)) throw new HttpError(409, 'INVALID_BOOKING_STATE');
    assertTransition(booking.status, to);
    const updated = await tx.booking.update({ where: { id: booking.id, tenantId: this.tenantId, version: booking.version },
      data: { status: to, ...(reason ? { cancellationReason: reason } : {}), version: { increment: 1 } } });
    await this.audit(tx, booking.id, `booking.${to.toLowerCase()}`, { status: to, ...(reason ? { reason } : {}) }, { status: booking.status });
    return updated;
  }
  async cancel(id: string, input: unknown) {
    this.permit('bookings:cancel');
    const { reason } = cancelBookingBody.parse(input);
    return this.lockedMutation(id, async (tx, booking, now) => {
      if (booking.status === 'HELD' && booking.holdExpiresAt && booking.holdExpiresAt <= now) throw new HttpError(409, 'HOLD_EXPIRED');
      if (booking.paidAt || booking.paymentReference || booking.paymentTransactionId) throw new HttpError(409, 'BOOKING_REVIEW_REQUIRED');
      if (await tx.payment.findFirst({ where: { tenantId: this.tenantId, bookingId: id, status: { not: 'FAILED' } }, select: { id: true } })) {
        throw new HttpError(409, 'BOOKING_REVIEW_REQUIRED');
      }
      return this.transition(tx, booking, 'CANCELLED', reason);
    });
  }
  /** Internal, timestamp-checked expiry. Reads need no cleanup job to free dates. */
  async expireHold(id: string) {
    this.permit('bookings:create');
    return this.lockedMutation(id, async (tx, booking, now) => {
      if (booking.status !== 'HELD') throw new HttpError(409, 'INVALID_BOOKING_STATE');
      if (!booking.holdExpiresAt || booking.holdExpiresAt > now) throw new HttpError(409, 'HOLD_NOT_EXPIRED');
      return this.transition(tx, booking, 'EXPIRED');
    });
  }
}
