import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type Payment } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from './authentication.js';
import { hasPermission, type Permission } from './authorization.js';
import { HttpError } from './errors.js';
import { BookingService, paymentAudit, type PaymentActor } from './booking-service.js';
import { tenantProperty } from './occupancy.js';
import { normalizeGuestPhone, idempotencyKey } from './booking-validation.js';
import { bankTransferBody, createPaymentBody, manualVerificationBody, paymentListQuery, paymentReviewBody } from './payment-validation.js';
import { validPaystackSignature, providerId, type PaymentProvider, type VerifiedTransaction } from './payment-provider.js';

const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 10000 };
const webhookBody = z.object({ event: z.string().max(100), data: z.object({ reference: z.string().regex(/^SLP-[a-f0-9]{32}$/), id: providerId }) });
function paymentResponse(payment: Payment) {
  return { id: payment.id, bookingId: payment.bookingId, reference: payment.reference, method: payment.method, status: payment.status,
    expectedAmountKobo: Number(payment.expectedAmountKobo), currency: payment.currency,
    receivedAmountKobo: payment.receivedAmountKobo === null ? null : Number(payment.receivedAmountKobo),
    receivedAt: payment.receivedAt, verifiedAt: payment.verifiedAt, verifierId: payment.verifierId,
    bookingConfirmed: payment.appliedAt !== null, reviewReason: payment.reviewReason, reviewNote: payment.reviewNote,
    transferInstructions: payment.instructionsSnapshot, authorizationUrl: payment.authorizationUrl,
    createdAt: payment.createdAt, updatedAt: payment.updatedAt };
}

export class PaymentService {
  constructor(private readonly db: PrismaClient, private readonly provider: PaymentProvider | undefined,
    private readonly auth?: AuthContext) {}
  private operator(permission: Permission) {
    if (!this.auth?.user.tenantId) throw new HttpError(401, 'UNAUTHORIZED');
    if (!hasPermission(this.auth.user.role, permission)) throw new HttpError(403, 'FORBIDDEN');
    return { tenantId: this.auth.user.tenantId, actor: { kind: 'USER', userId: this.auth.user.id } as PaymentActor };
  }
  private requireProvider() {
    if (!this.provider) throw new HttpError(503, 'PAYSTACK_TEST_DISABLED');
    return this.provider;
  }
  private async record(id: string, tenantId: string) {
    const payment = await this.db.payment.findFirst({ where: { id, tenantId } });
    if (!payment) throw new HttpError(404, 'NOT_FOUND');
    return payment;
  }
  async bankSettings() {
    const { tenantId } = this.operator('payment-settings:write');
    return this.db.bankTransferSetting.findUnique({ where: { tenantId }, select: { enabled: true, bankName: true, accountName: true, accountNumber: true } });
  }
  async configureBank(input: unknown) {
    const { tenantId, actor } = this.operator('payment-settings:write');
    const data = bankTransferBody.parse(input);
    return this.db.$transaction(async (tx) => {
      // Configuration writers and payment initiation serialize on the tenant row.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`;
      const setting = await tx.bankTransferSetting.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
      await paymentAudit(tx, tenantId, actor, 'payment.bank_settings_updated', 'Tenant', tenantId, {
        enabled: data.enabled, bankName: data.bankName, accountLastFour: data.accountNumber.slice(-4)
      });
      return { enabled: setting.enabled, bankName: setting.bankName, accountName: setting.accountName, accountNumber: setting.accountNumber };
    }, options);
  }
  async create(input: unknown, keyInput: unknown, beforeMutation?: (tx: Prisma.TransactionClient) => Promise<void>,
    afterCreation?: (tx: Prisma.TransactionClient, paymentId: string) => Promise<void>) {
    const { tenantId, actor } = this.operator('payments:create');
    const data = createPaymentBody.parse(input), key = idempotencyKey.parse(keyInput);
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const { payment, created } = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantId, 'payment.create', key])}, 44))::text`;
      await beforeMutation?.(tx);
      const existing = await tx.payment.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (existing) {
        if (existing.inputHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
        await afterCreation?.(tx,existing.id);
        return { payment: existing, created: false };
      }
      // Lock tenant before phone/property; no other payment mutation locks tenant afterwards.
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`;
      const first = await tx.booking.findFirst({ where: { id: data.bookingId, tenantId } });
      if (!first) throw new HttpError(404, 'NOT_FOUND');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId + ':' + normalizeGuestPhone(first.guestPhone)}, 42))::text`;
      const property = await tenantProperty(tx, tenantId, first.propertyId, true);
      const booking = await tx.booking.findFirstOrThrow({ where: { id: data.bookingId, tenantId } });
      if (!property.isActive) throw new HttpError(409, 'PROPERTY_INACTIVE');
      if (booking.status !== 'HELD' || !booking.holdExpiresAt || booking.holdExpiresAt <= new Date()) throw new HttpError(409, 'HOLD_NOT_PAYABLE');
      if (!booking.quoteSnapshot || booking.quoteTotalKobo < 1n || booking.quoteTotalKobo > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(409, 'QUOTE_REVIEW_REQUIRED');
      const reference = `SLP-${randomBytes(16).toString('hex')}`;
      let instructions: Prisma.InputJsonObject | undefined;
      if (data.method === 'MANUAL_TRANSFER') {
        const bank = await tx.bankTransferSetting.findUnique({ where: { tenantId } });
        if (!bank?.enabled) throw new HttpError(409, 'BANK_TRANSFER_DISABLED');
        instructions = { bankName: bank.bankName, accountName: bank.accountName, accountNumber: bank.accountNumber,
          reference, amountKobo: Number(booking.quoteTotalKobo), currency: booking.currency };
      } else this.requireProvider();
      const payment = await tx.payment.create({ data: { tenantId, bookingId: booking.id, reference, method: data.method,
        status: data.method === 'MANUAL_TRANSFER' ? 'PENDING' : 'INITIALIZING', expectedAmountKobo: booking.quoteTotalKobo,
        currency: booking.currency, idempotencyKey: key, inputHash: hash, instructionsSnapshot: instructions,
        providerReference: data.method === 'PAYSTACK_TEST' ? reference : null,
        customerEmail: data.method === 'PAYSTACK_TEST' ? data.email : null } });
      await afterCreation?.(tx,payment.id);
      await paymentAudit(tx, tenantId, actor, 'payment.initiated', 'Payment', payment.id, { reference, bookingId: booking.id, method: data.method, amountKobo: Number(payment.expectedAmountKobo) });
      return { payment, created: true };
    }, options);
    if (!created || payment.method === 'MANUAL_TRANSFER') return paymentResponse(payment);
    // HTTP occurs outside database locks. The stable reference is durable before initialization.
    let initialized: { reference: string; authorizationUrl: string } | undefined;
    try { initialized = await this.requireProvider().initialize({ reference: payment.reference, amountKobo: payment.expectedAmountKobo,
      currency: payment.currency, email: payment.customerEmail!, tenantId, bookingId: payment.bookingId, paymentId: payment.id }); } catch { /* persisted below */ }
    return this.db.$transaction(async (tx) => {
      const current = await BookingService.lockPayment(tx, tenantId, payment.id);
      // A webhook may already have verified this payment while initialization was in flight.
      if (current.payment.status !== 'INITIALIZING') return paymentResponse(current.payment);
      const updated = await tx.payment.update({ where: { id: payment.id, tenantId }, data: initialized ? {
        status: 'PENDING', authorizationUrl: initialized.authorizationUrl
      } : { status: 'REVIEW', reviewReason: 'INITIALIZATION_UNCERTAIN' } });
      if (!initialized) await BookingService.paymentReview(tx, tenantId, payment.id, actor, true);
      await paymentAudit(tx, tenantId, actor, initialized ? 'payment.checkout_initialized' : 'payment.initialization_review', 'Payment', payment.id, { reference: payment.reference });
      return paymentResponse(updated);
    }, options);
  }
  async get(id: string) {
    const { tenantId } = this.operator('payments:read');
    return paymentResponse(await this.record(id, tenantId));
  }
  async list(input: unknown) {
    const { tenantId } = this.operator('payments:read');
    const { bookingId, status, review, limit, offset } = paymentListQuery.parse(input);
    if (bookingId && !await this.db.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true } })) throw new HttpError(404, 'NOT_FOUND');
    const payments = await this.db.payment.findMany({ where: { tenantId, bookingId, status,
      ...(review ? { reviewReason: review === 'true' ? { not: null } : null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset });
    return { payments: payments.map((payment) => {
      const { transferInstructions: _instructions, authorizationUrl: _url, ...summary } = paymentResponse(payment);
      return summary;
    }), limit, offset };
  }
  async verifyManual(id: string, input: unknown) {
    const { tenantId, actor } = this.operator('payments:verify');
    const data = manualVerificationBody.parse(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const { payment } = await BookingService.lockPayment(tx, tenantId, id);
        if (payment.method !== 'MANUAL_TRANSFER') throw new HttpError(409, 'INVALID_PAYMENT_METHOD');
        if (payment.status === 'SUCCEEDED') throw new HttpError(409, 'PAYMENT_ALREADY_VERIFIED');
        // A mismatched receipt is still a claimed bank transaction. Replacing its
        // reference would free the old unique key and allow the same funds again.
        if (payment.manualReceiptReference !== null && payment.manualReceiptReference !== data.receiptReference) {
          throw new HttpError(409, 'RECEIPT_REFERENCE_IMMUTABLE');
        }
        const used = await tx.payment.findFirst({ where: { tenantId, manualReceiptReference: data.receiptReference, id: { not: id } }, select: { id: true } });
        if (used) throw new HttpError(409, 'RECEIPT_ALREADY_USED');
        const exact = payment.expectedAmountKobo === BigInt(data.confirmedAmountKobo), now = new Date();
        await tx.payment.update({ where: { id, tenantId }, data: { status: exact ? 'SUCCEEDED' : 'REVIEW',
          receivedAmountKobo: data.confirmedAmountKobo, receivedAt: now, verifiedAt: now,
          verifierId: actor.kind === 'USER' ? actor.userId : null, manualReceiptReference: data.receiptReference,
          reviewNote: data.note, reviewReason: exact ? null : 'AMOUNT_MISMATCH' } });
        await paymentAudit(tx, tenantId, actor, exact ? 'payment.manual_verified' : 'payment.manual_amount_mismatch', 'Payment', id, {
          confirmedAmountKobo: data.confirmedAmountKobo, reference: payment.reference
        });
        const reason = exact ? await BookingService.confirmVerifiedPayment(tx, tenantId, id, actor) : 'AMOUNT_MISMATCH';
        if (reason) {
          await tx.payment.update({ where: { id, tenantId }, data: { reviewReason: reason } });
          await BookingService.paymentReview(tx, tenantId, id, actor, false, true);
        }
        const updated = await tx.payment.findFirstOrThrow({ where: { id, tenantId } });
        return { payment: paymentResponse(updated), ...(exact ? {} : { error: 'AMOUNT_MISMATCH' }) };
      }, options);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new HttpError(409, 'RECEIPT_ALREADY_USED');
      throw error;
    }
  }
  async review(id: string, input: unknown) {
    const { tenantId, actor } = this.operator('payments:verify');
    const { note, decision } = paymentReviewBody.parse(input);
    return this.db.$transaction(async (tx) => {
      const { payment: current } = await BookingService.lockPayment(tx, tenantId, id);
      if (decision === 'CLOSE_UNPAID') {
        const details = current.providerDetails as { status?: string; associationMatched?: boolean } | null;
        const failedOnline = current.method === 'PAYSTACK_TEST' && current.status === 'FAILED' &&
          details?.associationMatched === true && ['failed', 'abandoned'].includes(details.status ?? '');
        const unreceivedManual = current.method === 'MANUAL_TRANSFER' && ['PENDING', 'REVIEW'].includes(current.status);
        if (current.receivedAmountKobo !== null || current.verifiedAt !== null || (!failedOnline && !unreceivedManual)) throw new HttpError(409, 'PAYMENT_REVIEW_REQUIRED');
        await tx.payment.update({ where: { id, tenantId }, data: { status: 'FAILED', reviewReason: null, reviewNote: note } });
        await BookingService.closeUnpaidReview(tx, tenantId, id, actor, note);
      }
      const payment = await tx.payment.update({ where: { id, tenantId }, data: { reviewNote: note } });
      await paymentAudit(tx, tenantId, actor, decision === 'NOTE' ? 'payment.review_noted' : 'payment.closed_unpaid', 'Payment', id, { note, decision });
      return paymentResponse(payment);
    }, options);
  }
  async verifyOnline(id: string) {
    const { tenantId, actor } = this.operator('payments:verify');
    await this.record(id, tenantId);
    return this.verifyProvider(tenantId, id, actor);
  }
  private async verifyProvider(tenantId: string, id: string, actor: PaymentActor, eventId?: string, eventTransactionId?: string) {
    const provider = this.requireProvider();
    const payment = await this.db.$transaction(async (tx) => {
      const { payment } = await BookingService.lockPayment(tx, tenantId, id);
      if (payment.method !== 'PAYSTACK_TEST') throw new HttpError(409, 'INVALID_PAYMENT_METHOD');
      if (payment.status !== 'SUCCEEDED') {
        await tx.payment.update({ where: { id, tenantId }, data: { status: 'VERIFYING', reviewReason: 'VERIFICATION_PENDING' } });
        await BookingService.paymentReview(tx, tenantId, id, actor, true);
      }
      return payment;
    }, options);
    let result: VerifiedTransaction | undefined;
    if (payment.status !== 'SUCCEEDED') { try { result = await provider.verify(payment.reference); } catch { /* retain review occupancy */ } }
    return this.db.$transaction(async (tx) => {
      const { payment: current } = await BookingService.lockPayment(tx, tenantId, id);
      if (eventId) {
        const event = await tx.webhookEvent.findUniqueOrThrow({ where: { id: eventId } });
        if (event.status === 'PROCESSED') return { payment: paymentResponse(current), retry: false };
      }
      let retry = false;
      if (current.status !== 'SUCCEEDED') {
        const identity = result !== undefined && result.domain === 'test' && result.reference === current.reference &&
          result.metadata.tenantId === tenantId && result.metadata.bookingId === current.bookingId && result.metadata.paymentId === id &&
          (!eventTransactionId || result.id === eventTransactionId);
        const exact = result !== undefined && identity && result.currency === current.currency && result.amountKobo === current.expectedAmountKobo;
        const successful = result !== undefined && exact && result.status === 'success' && result.paidAt !== null && Number.isFinite(Date.parse(result.paidAt));
        const pending = result && ['pending', 'processing', 'ongoing', 'queued'].includes(result.status);
        retry = !result || Boolean(identity && (pending || (eventId && result.status !== 'success')));
        const reason = !result ? 'PROVIDER_UNAVAILABLE' : !identity ? 'PROVIDER_ASSOCIATION_MISMATCH' :
          result.currency !== current.currency ? 'CURRENCY_MISMATCH' : result.amountKobo !== current.expectedAmountKobo ? 'AMOUNT_MISMATCH' :
          result.status === 'success' && !successful ? 'RECEIPT_TIME_MISSING' : pending ? 'VERIFICATION_PENDING' :
          result.status === 'success' ? null : 'PROVIDER_STATUS_REVIEW';
        // Serialize a provider transaction across different properties before claiming it.
        // The global unique index remains the final guard for privileged/raw writers.
        if (successful && result) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`paystack-test:${result.id}`}, 46))::text`;
        const duplicate = successful && result ? await tx.payment.findFirst({ where: { providerTransactionId: result.id, id: { not: id } }, select: { id: true } }) : null;
        const succeeded = successful && !duplicate && result !== undefined;
        await tx.payment.update({ where: { id, tenantId }, data: {
          status: succeeded ? 'SUCCEEDED' : result && identity && ['failed', 'abandoned'].includes(result.status) && !eventId ? 'FAILED' : 'REVIEW',
          reviewReason: duplicate ? 'PROVIDER_TRANSACTION_REUSED' : reason,
          ...(succeeded && result ? { providerTransactionId: result.id, receivedAmountKobo: result.amountKobo,
            receivedAt: new Date(result.paidAt!), verifiedAt: new Date() } : {}),
          providerDetails: result ? { domain: result.domain, status: result.status, associationMatched: Boolean(identity),
            amountMatched: Boolean(exact), currency: result.currency } : { status: 'unavailable' }
        } });
        await paymentAudit(tx, tenantId, actor, 'payment.provider_verified', 'Payment', id, {
          outcome: succeeded ? 'SUCCEEDED' : 'REVIEW', reason: duplicate ? 'PROVIDER_TRANSACTION_REUSED' : reason
        });
        const confirmationReason = succeeded ? await BookingService.confirmVerifiedPayment(tx, tenantId, id, actor) : duplicate ? 'PROVIDER_TRANSACTION_REUSED' : reason;
        if (confirmationReason) {
          await tx.payment.update({ where: { id, tenantId }, data: { reviewReason: confirmationReason } });
          await BookingService.paymentReview(tx, tenantId, id, actor, retry, Boolean(succeeded));
        }
      }
      if (eventId) await tx.webhookEvent.update({ where: { id: eventId, tenantId }, data: {
        status: retry ? 'RETRY' : 'PROCESSED', processedAt: retry ? null : new Date(), lastError: retry ? 'VERIFICATION_PENDING' : null
      } });
      return { payment: paymentResponse(await tx.payment.findFirstOrThrow({ where: { id, tenantId } })), retry };
    }, options);
  }
  async webhook(raw: Buffer, signature: unknown, secret: string | undefined) {
    this.requireProvider();
    if (!validPaystackSignature(raw, signature, secret)) throw new HttpError(401, 'INVALID_WEBHOOK_SIGNATURE');
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'INVALID_REQUEST'); }
    const event = webhookBody.safeParse(parsed);
    // Signed events from other Paystack products/references are irrelevant to this integration.
    if (!event.success) return { retry: false, ignored: true };
    const payment = await this.db.payment.findUnique({ where: { providerReference: event.data.data.reference } });
    const eventId = `${event.data.event}:${event.data.data.reference}:${event.data.data.id}`;
    // createMany(skipDuplicates) is an atomic INSERT ON CONFLICT DO NOTHING.
    // Prisma's empty-update upsert can emulate read/create and race on delivery.
    await this.db.webhookEvent.createMany({ skipDuplicates: true, data: [{
      tenantId: payment?.tenantId, provider: 'paystack-test', eventId, eventType: event.data.event,
      rawBody: { reference: event.data.data.reference, transactionId: event.data.data.id }, status: 'RECEIVED'
    }] });
    const stored = await this.db.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: 'paystack-test', eventId } } });
    if (stored.status === 'PROCESSED') return { retry: false, duplicate: true };
    if (!payment || event.data.event !== 'charge.success') {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WebhookEvent" WHERE id = ${stored.id} FOR UPDATE`;
        const current = await tx.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
        if (current.status === 'PROCESSED') return;
        if (payment) await paymentAudit(tx, payment.tenantId, { kind: 'PROVIDER' }, 'payment.unsupported_event', 'Payment', payment.id, { eventType: event.data.event });
        await tx.webhookEvent.update({ where: { id: stored.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
      });
      return { retry: false, ignored: true };
    }
    return this.verifyProvider(payment.tenantId, payment.id, { kind: 'PROVIDER' }, stored.id, event.data.data.id);
  }
}
