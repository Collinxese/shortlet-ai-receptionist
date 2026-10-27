import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import { PaymentService } from '../../src/services/payment-service.js';
import { BookingService } from '../../src/services/booking-service.js';
import { isolatedDatabase } from './database.js';

test('Phase 4.1 manual receipt history and atomicity regressions', async (t) => {
  const { db, deploy } = await isolatedDatabase(t);
  deploy();
  const tenant = await db.tenant.create({ data: { name: 'Disposable Phase 4.1 audit' } });
  const user = await db.user.create({ data: { tenantId: tenant.id, role: 'OWNER', name: 'Synthetic audit owner',
    email: 'phase41-receipts@example.com', passwordHash: 'not-a-real-password-hash' } });
  const context = { user, sessionId: 'disposable-service-test' };
  const payments = new PaymentService(db, undefined, context);
  const bookings = new BookingService(db, context);
  let sequence = 0;
  await payments.configureBank({ enabled: true, bankName: 'Synthetic bank', accountName: 'Synthetic operator', accountNumber: '0123456789' });
  const attempt = async () => {
    const property = await db.property.create({ data: { tenantId: tenant.id, name: 'Synthetic room', area: 'Lagos', bedrooms: 1,
      bathrooms: 1, maxGuests: 2, baseNightlyPriceKobo: 10001n } });
    const booking = await bookings.create('HELD', { propertyId: property.id, guestName: 'Synthetic guest',
      guestPhone: `+234809${String(++sequence).padStart(7,'0')}`, guestCount: 1, checkIn: '2027-02-01', checkOut: '2027-02-02' }, `phase41-receipt-hold-${sequence}`) as { id: string };
    const payment = await payments.create({ bookingId: booking.id, method: 'MANUAL_TRANSFER' }, `phase41-receipt-attempt-${sequence}`);
    return { booking, payment };
  };
  const receipt = (amount: number, reference: string) => ({ confirmedAmountKobo: amount, receiptReference: reference,
    receiptConfirmed: true as const, note: 'Synthetic ledger check; no real bank transfer' });

  await t.test('correcting a mismatched amount cannot release its original bank reference for reuse', async () => {
    const first = await attempt(), second = await attempt();
    const original = 'phase41-original-bank-receipt';
    const mismatch = await payments.verifyManual(first.payment.id, receipt(10000, original));
    assert.equal(mismatch.error, 'AMOUNT_MISMATCH');
    const before = await db.payment.findUniqueOrThrow({ where: { id: first.payment.id } });
    await assert.rejects(payments.verifyManual(first.payment.id, receipt(10001, 'phase41-replacement-receipt')),
      (error: unknown) => (error as { code: string }).code === 'RECEIPT_REFERENCE_IMMUTABLE');
    assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: first.payment.id } }), before);
    const corrected = await payments.verifyManual(first.payment.id, receipt(10001, original));
    assert.equal(corrected.payment.bookingConfirmed, true);
    await assert.rejects(payments.verifyManual(second.payment.id, receipt(10001, original)),
      (error: unknown) => (error as { code: string }).code === 'RECEIPT_ALREADY_USED');
    assert.equal((await db.payment.findUniqueOrThrow({ where: { id: second.payment.id } })).status, 'PENDING');
  });

  await t.test('manual confirmation audit failure rolls back proof, booking and audit together and permits safe retry', async () => {
    const { booking, payment } = await attempt();
    const before = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    await db.$executeRawUnsafe(`CREATE FUNCTION phase41_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'booking.confirmed' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER phase41_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION phase41_audit_failure()');
    try {
      await assert.rejects(payments.verifyManual(payment.id, receipt(10001, 'phase41-audit-failure-receipt')), /Synthetic audit failure/);
      assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { id: payment.id } }), before);
      assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'HELD');
      assert.equal(await db.auditLog.count({ where: { entityId: payment.id, action: 'payment.manual_verified' } }), 0);
      assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.confirmed' } }), 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER phase41_audit_failure ON "AuditLog"');
      await db.$executeRawUnsafe('DROP FUNCTION phase41_audit_failure()');
    }
    assert.equal((await payments.verifyManual(payment.id, receipt(10001, 'phase41-audit-failure-receipt'))).payment.bookingConfirmed, true);
  });

  await t.test('screenshots, guest claims and unauthorized actors cannot establish receipt proof', async () => {
    const { booking, payment } = await attempt();
    for (const input of [
      { ...receipt(10001, 'phase41-claim'), screenshotUrl: 'https://example.com/claim.png' },
      { ...receipt(10001, 'phase41-claim'), guestSaysPaid: true },
      { confirmedAmountKobo: 10001, receiptReference: 'phase41-claim', note: 'Guest says payment sent' }
    ]) await assert.rejects(payments.verifyManual(payment.id, input), ZodError);
    await assert.rejects(new PaymentService(db, undefined).verifyManual(payment.id, receipt(10001, 'phase41-claim')),
      (error: unknown) => (error as { code: string }).code === 'UNAUTHORIZED');
    await assert.rejects(new PaymentService(db, undefined, { ...context, user: { ...user, role: 'RECEPTIONIST' } })
      .verifyManual(payment.id, receipt(10001, 'phase41-claim')),
      (error: unknown) => (error as { code: string }).code === 'FORBIDDEN');
    assert.equal((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status, 'PENDING');
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'HELD');
    assert.equal(await db.auditLog.count({ where: { entityId: payment.id, action: 'payment.manual_verified' } }), 0);
  });
});
