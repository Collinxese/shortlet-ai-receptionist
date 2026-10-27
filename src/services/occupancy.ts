import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { HttpError } from './errors.js';
import { propertyInclude } from './property-data.js';
import { lagosDayStart } from './calendar.js';
import type { DateRange } from './availability.js';

/** Internal context only; the HTTP response still exposes just the safe error code. */
export class HoldIntegrityError extends HttpError {
  constructor(readonly propertyId: string) {
    super(409, 'OCCUPANCY_REVIEW_REQUIRED');
  }
}

/** Every application occupancy writer locks this tenant-owned row first. */
export async function tenantProperty(tx: Prisma.TransactionClient, tenantId: string, propertyId: string, lock = false) {
  if (lock) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Property"
      WHERE id = ${propertyId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND');
  }
  const property = await tx.property.findFirst({ where: { id: propertyId, tenantId }, include: propertyInclude });
  if (!property) throw new HttpError(404, 'NOT_FOUND');
  return property;
}

export async function occupyingBookings(tx: Prisma.TransactionClient, tenantId: string, propertyId: string, range: DateRange, now: Date, excludeId?: string) {
  // A missing expiry is corrupt data, not evidence that the dates are free.
  const malformed = await tx.booking.findFirst({ where: { tenantId, propertyId, status: 'HELD', holdExpiresAt: null }, select: { id: true } });
  if (malformed) throw new HoldIntegrityError(propertyId);
  const rows = await tx.booking.findMany({ where: {
    tenantId, propertyId, ...(excludeId ? { id: { not: excludeId } } : {}),
    // Compare Lagos days, including legacy rows with clock times.
    checkIn: { lt: range.checkOut }, checkOut: { gte: range.checkIn },
    OR: [{ status: { in: ['CONFIRMED', 'PAYMENT_REVIEW', 'VERIFICATION_PENDING'] } }, { status: 'HELD', holdExpiresAt: { gt: now } }]
  }, select: { checkIn: true, checkOut: true, status: true, holdExpiresAt: true } });
  return rows.map((row) => ({ ...row, checkIn: lagosDayStart(row.checkIn), checkOut: lagosDayStart(row.checkOut) }));
}

/** Persist an integrity alert outside the rejected mutation's rolled-back transaction. */
export async function integrityAlert(db: PrismaClient, auth: AuthContext, propertyId: string, error: unknown): Promise<never> {
  if (error instanceof HttpError && error.code === 'OCCUPANCY_REVIEW_REQUIRED') {
    await db.auditLog.create({ data: {
      tenantId: auth.user.tenantId, actorId: auth.user.id, actorType: 'USER',
      action: 'booking.integrity_review_required', entityType: 'Property',
      entityId: error instanceof HoldIntegrityError ? error.propertyId : propertyId,
      after: { issue: 'HELD_WITHOUT_EXPIRY', mutationRejected: true }
    } });
  }
  throw error;
}
