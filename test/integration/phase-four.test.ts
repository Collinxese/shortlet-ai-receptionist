import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { HTTPMethods } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { PaymentService } from '../../src/services/payment-service.js';
import { BookingService } from '../../src/services/booking-service.js';
import type { PublicUser } from '../../src/services/authentication.js';
import type { PaymentProvider, ProviderInput, VerifiedTransaction } from '../../src/services/payment-provider.js';
import { lagosMidnight } from '../../src/services/calendar.js';
import { isolatedDatabase } from './database.js';

type Account = { accessToken: string; user: PublicUser };
const secret = 'sk_test_disposablefixture';
test('Phase 4 payment foundation against disposable PostgreSQL and fake test provider', async (t) => {
  const { db, databaseUrl, deploy } = await isolatedDatabase(t);
  deploy();
  let sequence = 0, initializeCount = 0, verifyCount = 0;
  const initialized = new Map<string, ProviderInput>();
  const answers = new Map<string, Partial<VerifiedTransaction> | 'unavailable'>();
  let initializeGate: Promise<void> | undefined, verifyGate: Promise<void> | undefined, initializationUnavailable = false;
  const provider: PaymentProvider = {
    async initialize(input) {
      initializeCount++; initialized.set(input.reference, input);
      await initializeGate;
      if (initializationUnavailable) throw new Error('Ambiguous initialization');
      return { reference: input.reference, authorizationUrl: 'https://checkout.paystack.com/fake-test' };
    },
    async verify(reference) {
      verifyCount++;
      await verifyGate;
      const input = initialized.get(reference)!;
      const answer = answers.get(reference);
      if (answer === 'unavailable') throw new Error('test provider unavailable');
      return { id: String(++sequence), domain: 'test', status: 'success', reference,
        amountKobo: input.amountKobo, currency: input.currency, paidAt: new Date().toISOString(),
        metadata: { tenantId: input.tenantId, bookingId: input.bookingId, paymentId: input.paymentId }, ...answer };
    }
  };
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_RATE_LIMIT_MAX: '30',
    PAYSTACK_TEST_ENABLED: 'true', PAYSTACK_TEST_SECRET_KEY: secret }), { db, logger: false, paymentProvider: provider });
  t.after(() => app.close());
  const request = (method: HTTPMethods, path: string, actor?: Account, payload?: object, key?: string) => app.inject({
    method, url: `/api${path}`, remoteAddress: `198.51.${Math.floor(sequence / 200) % 250}.${++sequence % 200 + 1}`,
    headers: { ...(actor ? { authorization: `Bearer ${actor.accessToken}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, payload
  });
  const password = 'phase-four-test-password';
  const register = async (name: string): Promise<Account> => {
    const result = await request('POST', '/auth/register', undefined, { tenantName: name, name, email: `${name}@example.com`, password });
    assert.equal(result.statusCode, 201, result.body); return result.json();
  };
  const a = await register('payment-owner-a'), b = await register('payment-owner-b');
  const staff = async (role: 'MANAGER' | 'RECEPTIONIST'): Promise<Account> => {
    const email = `${role.toLowerCase()}@example.com`;
    assert.equal((await request('POST', '/team', a, { name: role, email, password, role })).statusCode, 201);
    return (await request('POST', '/auth/login', undefined, { email, password })).json();
  };
  const manager = await staff('MANAGER'), receptionist = await staff('RECEPTIONIST');
  const context = (actor = a) => ({ user: actor.user, sessionId: 'test-only' });
  const bank = { enabled: true, bankName: 'Test bank', accountName: 'Test operator', accountNumber: '0123456789' };
  const room = (actor = a) => db.property.create({ data: { tenantId: actor.user.tenantId, name: 'Payment room', area: 'Lekki',
    bedrooms: 1, bathrooms: 1, maxGuests: 4, baseNightlyPriceKobo: 10001n, weekendNightlyPriceKobo: 20003n, cleaningFeeKobo: 101n } });
  const held = async (actor = a, configuredProperty?: Awaited<ReturnType<typeof room>>) => {
    const property = configuredProperty ?? await room(actor);
    const response = await request('POST', '/holds', actor, { propertyId: property.id, checkIn: '2027-01-08', checkOut: '2027-01-11',
      guestName: 'Private guest', guestPhone: `+23480${String(++sequence).padStart(8, '0')}`, guestCount: 2 }, `phase-four-hold-${++sequence}`);
    assert.equal(response.statusCode, 201, response.body);
    return { property, booking: response.json().booking };
  };
  const payment = async (bookingId: string, method: 'MANUAL_TRANSFER' | 'PAYSTACK_TEST' = 'MANUAL_TRANSFER', actor = a, key = `phase-four-payment-${++sequence}`) => {
    const response = await request('POST', '/payments', actor, { bookingId, method, ...(method === 'PAYSTACK_TEST' ? { email: 'guest@example.com' } : {}) }, key);
    assert.equal(response.statusCode, 201, response.body); return response.json().payment;
  };
  const manual = (id: string, amount: number, actor = a, receiptReference = `receipt-${++sequence}`) =>
    request('POST', `/payments/${id}/verify-manual`, actor, { confirmedAmountKobo: amount, receiptReference, receiptConfirmed: true, note: 'Receipt checked in bank ledger' });
  const verify = (id: string, actor = manager) => request('POST', `/payments/${id}/verify`, actor);
  const stored = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });
  const bookingStored = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });
  const webhook = (reference: string, id: string, signature?: string, event = 'charge.success') => {
    const payload = `{ "event": ${JSON.stringify(event)}, "data": ${JSON.stringify({ reference, id, amount: 1, customer: { email: 'do-not-store@example.com' } })} }\n`;
    return app.inject({ method: 'POST', url: '/api/webhooks/paystack', remoteAddress: `203.0.113.${++sequence % 200 + 1}`,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature ?? createHmac('sha512', secret).update(payload).digest('hex') }, payload });
  };

  await t.test('bank configuration is restricted, validated, tenant-scoped, auditable and disabled by default', async () => {
    assert.equal((await request('GET', '/payment-settings/bank-transfer', a)).json().settings, null);
    const { booking } = await held();
    assert.equal((await request('POST', '/payments', a, { bookingId: booking.id, method: 'MANUAL_TRANSFER' }, 'disabled-bank')).statusCode, 409);
    for (const method of ['GET', 'PUT'] as const) assert.equal((await request(method, '/payment-settings/bank-transfer', receptionist, method === 'PUT' ? bank : undefined)).statusCode, 403);
    assert.equal((await request('PUT', '/payment-settings/bank-transfer', manager, { ...bank, accountNumber: '123' })).statusCode, 400);
    assert.equal((await request('PUT', '/payment-settings/bank-transfer', manager, { ...bank, tenantId: b.user.tenantId })).statusCode, 400);
    assert.equal((await request('PUT', '/payment-settings/bank-transfer', manager, bank)).statusCode, 200);
    assert.equal((await request('GET', '/payment-settings/bank-transfer', b)).json().settings, null);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'payment.bank_settings_updated' } });
    assert.equal(audit.actorId, manager.user.id); assert.equal(audit.tenantId, a.user.tenantId);
    assert.equal(JSON.stringify(audit).includes(bank.accountNumber), false);
  });

  await t.test('manual transfer stays pending; instructions and quote are snapshotted; idempotency rejects changed input', async () => {
    const { booking } = await held();
    const p = await payment(booking.id, 'MANUAL_TRANSFER', receptionist, 'manual-idempotency');
    assert.equal(p.status, 'PENDING'); assert.equal(p.bookingConfirmed, false);
    assert.equal(p.expectedAmountKobo, 50108); // Fri/Sat 20003 each + Sun 10001 + cleaning 101.
    assert.equal(p.transferInstructions.accountNumber, bank.accountNumber);
    await request('PUT', '/payment-settings/bank-transfer', a, { ...bank, accountNumber: '9876543210' });
    const replay = await payment(booking.id, 'MANUAL_TRANSFER', manager, 'manual-idempotency');
    assert.deepEqual(replay, p);
    const conflict = await request('POST', '/payments', a, { bookingId: booking.id, method: 'PAYSTACK_TEST', email: 'guest@example.com' }, 'manual-idempotency');
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await db.payment.count({ where: { bookingId: booking.id } }), 1);
    assert.equal((await bookingStored(booking.id)).status, 'HELD');
    assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, a, { reason: 'Pending funds' })).statusCode, 409);
  });

  await t.test('OWNER and MANAGER verify real receipt explicitly; exact payment atomically confirms only once', async () => {
    for (const actor of [a, manager]) {
      const { booking, property } = await held(); const p = await payment(booking.id);
      const result = await manual(p.id, p.expectedAmountKobo, actor);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().payment.status, 'SUCCEEDED'); assert.equal(result.json().payment.bookingConfirmed, true);
      assert.equal(result.json().payment.verifierId, actor.user.id);
      const confirmed = await bookingStored(booking.id);
      assert.equal(confirmed.status, 'CONFIRMED'); assert.equal(confirmed.paymentReference, p.reference);
      assert.equal(confirmed.quoteTotalKobo, BigInt(p.expectedAmountKobo)); assert.ok(confirmed.paidAt);
      assert.equal((await manual(p.id, p.expectedAmountKobo, actor)).statusCode, 409);
      assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.confirmed' } }), 1);
      const second = await request('POST', `/properties/${property.id}/blocks`, a, { startDate: '2027-01-08', endDate: '2027-01-11', reason: 'Cannot overwrite confirmed' });
      assert.equal(second.statusCode, 409);
      assert.equal((await request('POST', `/bookings/${booking.id}/cancel`, a, { reason: 'No refunds implemented' })).statusCode, 409);
    }
  });

  await t.test('payment uses every snapshotted nightly override and fee even after property pricing and policies change', async () => {
    const property = await room();
    await db.propertyFee.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, label: 'Parking', amountKobo: 103 } });
    await db.priceRule.create({ data: { tenantId: a.user.tenantId, propertyId: property.id, label: 'Friday event',
      startDate: lagosMidnight('2027-01-08'), endDate: lagosMidnight('2027-01-09'), nightlyPriceKobo: 30007 } });
    const { booking } = await held(a, property); const p = await payment(booking.id);
    assert.equal(p.expectedAmountKobo, 60215);
    const before = await bookingStored(booking.id);
    assert.equal((await request('PATCH', `/properties/${property.id}`, manager, { baseNightlyPriceKobo: 99999, cancellationPolicy: 'Changed later', cleaningFeeKobo: 1000 })).statusCode, 200);
    assert.equal((await manual(p.id, 60215)).statusCode, 200);
    assert.deepEqual((await bookingStored(booking.id)).quoteSnapshot, before.quoteSnapshot);
    assert.deepEqual((await bookingStored(booking.id)).policySnapshot, before.policySnapshot);
    assert.equal((await stored(p.id)).expectedAmountKobo, 60215n);
    await assert.rejects(db.payment.update({ where: { id: p.id }, data: { receivedAmountKobo: 1 } }), /Payment_terms_immutable/);
    assert.equal((await bookingStored(booking.id)).status, 'CONFIRMED');
  });

  await t.test('wrong manual amount is rejected into review; review note and corrected verified receipt are auditable', async () => {
    const { booking } = await held(); const p = await payment(booking.id);
    const receipt = `mismatch-receipt-${++sequence}`;
    const bad = await manual(p.id, p.expectedAmountKobo - 1, a, receipt);
    assert.equal(bad.statusCode, 409, bad.body); assert.equal(bad.json().error, 'AMOUNT_MISMATCH');
    assert.equal((await stored(p.id)).status, 'REVIEW'); assert.equal((await bookingStored(booking.id)).status, 'PAYMENT_REVIEW');
    const note = await request('POST', `/payments/${p.id}/review`, manager, { note: 'Awaiting balance; no refund or release authorized' });
    assert.equal(note.statusCode, 200); assert.match(note.json().payment.reviewNote, /Awaiting balance/);
    assert.equal((await manual(p.id, p.expectedAmountKobo, manager, receipt)).statusCode, 200);
    assert.equal((await bookingStored(booking.id)).status, 'CONFIRMED');
    assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.manual_amount_mismatch' } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.review_noted' } }), 1);
  });

  await t.test('receipt reuse and concurrent manual verification cannot duplicate a confirmation', async () => {
    const first = await held(), second = await held();
    const p = await payment(first.booking.id), q = await payment(second.booking.id);
    const receipt = 'same-bank-transaction';
    const results = await Promise.all([manual(p.id, p.expectedAmountKobo, a, receipt), manual(q.id, q.expectedAmountKobo, a, receipt)]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], results.map((r) => r.body).join('\n'));
    const third = await held(); const r = await payment(third.booking.id);
    const duplicate = await Promise.all([manual(r.id, r.expectedAmountKobo), manual(r.id, r.expectedAmountKobo, manager)]);
    assert.deepEqual(duplicate.map((v) => v.statusCode).sort(), [200, 409]);
  });

  await t.test('every payment route enforces roles, authentication, tenant ownership and strict fields', async () => {
    const { booking } = await held(); const p = await payment(booking.id);
    for (const [method, path, body] of [
      ['GET', `/payments/${p.id}`, undefined], ['POST', `/payments/${p.id}/verify`, undefined],
      ['POST', `/payments/${p.id}/verify-manual`, { confirmedAmountKobo: p.expectedAmountKobo, receiptReference: 'foreign-receipt', receiptConfirmed: true, note: 'No' }],
      ['POST', `/payments/${p.id}/review`, { note: 'No' }], ['GET', `/payments?bookingId=${booking.id}`, undefined]
    ] as const) {
      assert.equal((await request(method, path, b, body)).statusCode, 404, path);
      assert.equal((await request(method, path, undefined, body)).statusCode, 401, path);
    }
    for (const action of ['verify', 'verify-manual', 'review']) assert.equal((await request('POST', `/payments/${p.id}/${action}`, receptionist, {})).statusCode, 403);
    assert.equal((await request('GET', `/payments/${p.id}`, receptionist)).statusCode, 200);
    assert.equal((await request('GET', '/payments', b)).json().payments.length, 0);
    assert.equal((await request('POST', '/payments', b, { bookingId: booking.id, method: 'MANUAL_TRANSFER' }, 'foreign-booking')).statusCode, 404);
    for (const patch of [{ tenantId: b.user.tenantId }, { status: 'SUCCEEDED' }, { expectedAmountKobo: 1 }]) {
      assert.equal((await request('POST', '/payments', a, { bookingId: booking.id, method: 'MANUAL_TRANSFER', ...patch }, `invalid-${++sequence}`)).statusCode, 400);
    }
    assert.equal((await request('POST', `/payments/${p.id}/verify-manual`, a, { confirmedAmountKobo: 1.5, receiptConfirmed: true, receiptReference: 'abc', note: 'No' })).statusCode, 400);
    assert.equal((await request('POST', `/payments/${p.id}/verify-manual`, a, { confirmedAmountKobo: p.expectedAmountKobo, receiptReference: 'screenshot', note: 'Claim only' })).statusCode, 400);
    assert.equal((await stored(p.id)).status, 'PENDING');
    assert.equal((await request('GET', '/payments', a)).body.includes(bank.accountNumber), false);
    await assert.rejects(db.payment.update({ where: { id: p.id }, data: { expectedAmountKobo: 1 } }), /Payment_terms_immutable/);
    await assert.rejects(db.payment.update({ where: { id: p.id }, data: { tenantId: b.user.tenantId } }), /Payment_terms_immutable/);
    await assert.rejects(db.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } }), /Payment_confirmation_required/);
  });

  await t.test('audit failure rolls back manual receipt and booking; failed configuration leaves no partial change', async () => {
    const { booking } = await held(); const p = await payment(booking.id);
    const ghost = new PaymentService(db, provider, { user: { ...a.user, id: 'nonexistent-audit-actor' }, sessionId: 'test' });
    const before = await stored(p.id), auditCount = await db.auditLog.count({ where: { tenantId: a.user.tenantId } });
    await assert.rejects(ghost.verifyManual(p.id, { confirmedAmountKobo: p.expectedAmountKobo, receiptReference: 'rollback-receipt', receiptConfirmed: true, note: 'Test audit rollback' }));
    assert.deepEqual(await stored(p.id), before); assert.equal((await bookingStored(booking.id)).status, 'HELD');
    const settingsBefore = await db.bankTransferSetting.findUnique({ where: { tenantId: a.user.tenantId } });
    await assert.rejects(ghost.configureBank({ ...bank, enabled: false }));
    assert.deepEqual(await db.bankTransferSetting.findUnique({ where: { tenantId: a.user.tenantId } }), settingsBefore);
    assert.equal(await db.auditLog.count({ where: { tenantId: a.user.tenantId } }), auditCount);
  });

  await t.test('concurrent idempotent checkout initializes once and returns the stable original reference', async () => {
    const { booking } = await held(); let release!: () => void;
    initializeGate = new Promise<void>((resolve) => { release = resolve; });
    const count = initializeCount;
    const first = payment(booking.id, 'PAYSTACK_TEST', a, 'concurrent-initialization');
    // Wait for initialization to enter the injected transport without sleeping on the event loop.
    while (initializeCount === count) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await payment(booking.id, 'PAYSTACK_TEST', a, 'concurrent-initialization');
    assert.equal(second.status, 'INITIALIZING'); assert.equal(initializeCount, count + 1);
    release(); initializeGate = undefined;
    const original = await first;
    assert.equal(original.id, second.id); assert.equal(original.reference, second.reference);
    assert.equal(original.status, 'PENDING'); assert.equal(await db.payment.count({ where: { bookingId: booking.id } }), 1);
  });

  await t.test('uncertain initialization is durable, reserves review occupancy and never blindly initializes again', async () => {
    const { booking } = await held();
    initializationUnavailable = true;
    let p;
    try { p = await payment(booking.id, 'PAYSTACK_TEST', a, 'uncertain-checkout'); }
    finally { initializationUnavailable = false; }
    assert.equal(p.status, 'REVIEW'); assert.equal(p.reviewReason, 'INITIALIZATION_UNCERTAIN');
    assert.equal((await bookingStored(booking.id)).status, 'VERIFICATION_PENDING');
    const before = initializeCount;
    assert.equal((await payment(booking.id, 'PAYSTACK_TEST', a, 'uncertain-checkout')).id, p.id);
    assert.equal(initializeCount, before);
    const closed = await request('POST', `/payments/${p.id}/review`, a, { decision: 'CLOSE_UNPAID', noFundsConfirmed: true, note: 'Uncertain result cannot be closed' });
    assert.equal(closed.statusCode, 409);
    answers.set(p.reference, { id: '91000' });
    assert.equal((await verify(p.id)).json().payment.bookingConfirmed, true);
  });

  await t.test('invalid signatures do not create events; signed success is independently verified and private fields discarded', async () => {
    const { booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
    const count = await db.webhookEvent.count();
    assert.equal((await webhook(p.reference, '91001', '0'.repeat(128))).statusCode, 401);
    assert.equal(await db.webhookEvent.count(), count);
    answers.set(p.reference, { id: '91001' });
    const result = await webhook(p.reference, '91001');
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((await stored(p.id)).status, 'SUCCEEDED'); assert.equal((await bookingStored(booking.id)).status, 'CONFIRMED');
    const event = await db.webhookEvent.findFirstOrThrow({ where: { eventId: `charge.success:${p.reference}:91001` } });
    assert.equal(event.status, 'PROCESSED'); assert.equal(event.tenantId, a.user.tenantId);
    assert.equal(JSON.stringify(event).includes('do-not-store@example.com'), false);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: p.id, action: 'payment.provider_verified' } });
    assert.equal(audit.actorId, null); assert.equal(audit.actorType, 'PROVIDER');
    const before = verifyCount;
    assert.equal((await webhook(p.reference, '91001')).statusCode, 200); assert.equal(verifyCount, before);
    assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.confirmed' } }), 1);
  });

  await t.test('concurrent duplicate webhooks and operator verification confirm and audit exactly once', async () => {
    const { booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
    answers.set(p.reference, { id: '91002' });
    const results = await Promise.all([webhook(p.reference, '91002'), webhook(p.reference, '91002'), verify(p.id)]);
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200], results.map((r) => r.body).join('\n'));
    assert.equal((await stored(p.id)).appliedAt !== null, true);
    assert.equal(await db.webhookEvent.count({ where: { eventId: `charge.success:${p.reference}:91002` } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.provider_verified' } }), 1);
    assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.confirmed' } }), 1);
  });

  await t.test('provider amount, currency, reference, test domain, metadata and event transaction must all match', async () => {
    const patches: Partial<VerifiedTransaction>[] = [{ amountKobo: 1n }, { currency: 'USD' }, { reference: 'wrong' }, { domain: 'live' },
      { metadata: { tenantId: b.user.tenantId, bookingId: 'wrong', paymentId: 'wrong' } }, { id: 'other-transaction' }, { paidAt: null }];
    for (const patch of patches) {
      const { booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
      const id = String(++sequence); answers.set(p.reference, { id, ...patch });
      const result = await webhook(p.reference, id);
      assert.equal(result.statusCode, 200, result.body);
      const record = await stored(p.id); assert.equal(record.status, 'REVIEW'); assert.ok(record.reviewReason);
      assert.equal(record.appliedAt, null); assert.notEqual((await bookingStored(booking.id)).status, 'CONFIRMED');
    }
  });

  await t.test('unavailable and pending verification preserve review occupancy and durable event retries can later succeed', async () => {
    const { booking, property } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
    answers.set(p.reference, 'unavailable');
    assert.equal((await webhook(p.reference, '91003')).statusCode, 503);
    assert.equal((await stored(p.id)).reviewReason, 'PROVIDER_UNAVAILABLE');
    assert.equal((await bookingStored(booking.id)).status, 'VERIFICATION_PENDING');
    const bookingService = new BookingService(db, context(), () => new Date(Date.parse(booking.holdExpiresAt) + 1));
    await assert.rejects(bookingService.expireHold(booking.id), (e: unknown) => (e as { code: string }).code === 'INVALID_BOOKING_STATE');
    assert.equal((await request('GET', `/properties/${property.id}/availability?checkIn=2027-01-08&checkOut=2027-01-11`, receptionist)).json().available, false);
    answers.set(p.reference, { id: '91003', status: 'pending' });
    assert.equal((await webhook(p.reference, '91003')).statusCode, 503);
    assert.equal((await db.webhookEvent.findFirstOrThrow({ where: { eventId: `charge.success:${p.reference}:91003` } })).status, 'RETRY');
    answers.set(p.reference, { id: '91003' });
    assert.equal((await webhook(p.reference, '91003')).statusCode, 200);
    assert.equal((await bookingStored(booking.id)).status, 'CONFIRMED');
    assert.equal((await db.webhookEvent.findFirstOrThrow({ where: { eventId: `charge.success:${p.reference}:91003` } })).status, 'PROCESSED');
  });

  await t.test('verified failed transactions, unsupported notifications and unknown references never confirm', async () => {
    const { booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
    answers.set(p.reference, { status: 'failed' });
    assert.equal((await verify(p.id)).statusCode, 200);
    assert.equal((await stored(p.id)).status, 'FAILED'); assert.equal((await bookingStored(booking.id)).status, 'PAYMENT_REVIEW');
    const unsupported = await Promise.all(Array.from({ length: 4 }, () => webhook(p.reference, '91004', undefined, 'refund.processed')));
    assert.deepEqual(unsupported.map((r) => r.statusCode), [200, 200, 200, 200]);
    assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.unsupported_event' } }), 1);
    assert.equal((await webhook('SLP-' + 'f'.repeat(32), '91005')).statusCode, 200);
    assert.notEqual((await bookingStored(booking.id)).status, 'CONFIRMED');
    const close = await request('POST', `/payments/${p.id}/review`, manager, { decision: 'CLOSE_UNPAID', noFundsConfirmed: true, note: 'Provider confirmed failed; no receipt' });
    assert.equal(close.statusCode, 200, close.body); assert.equal((await bookingStored(booking.id)).status, 'CANCELLED');
    assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.closed_unpaid' } }), 1);
  });

  await t.test('unpaid review decisions require explicit attestation, preserve any receipt and reject other pending attempts', async () => {
    const first = await held(); const p = await payment(first.booking.id);
    assert.equal((await request('POST', `/payments/${p.id}/review`, a, { decision: 'CLOSE_UNPAID', note: 'No attestation' })).statusCode, 400);
    const other = await payment(first.booking.id, 'PAYSTACK_TEST');
    assert.equal((await request('POST', `/payments/${p.id}/review`, a, { decision: 'CLOSE_UNPAID', noFundsConfirmed: true, note: 'Other attempt still pending' })).statusCode, 409);
    assert.equal((await stored(p.id)).status, 'PENDING'); assert.equal((await stored(other.id)).status, 'PENDING');
    const second = await held(); const q = await payment(second.booking.id);
    assert.equal((await manual(q.id, q.expectedAmountKobo - 1)).statusCode, 409);
    assert.equal((await request('POST', `/payments/${q.id}/review`, manager, { decision: 'CLOSE_UNPAID', noFundsConfirmed: true, note: 'Cannot dismiss partial funds' })).statusCode, 409);
    assert.equal((await bookingStored(second.booking.id)).status, 'PAYMENT_REVIEW');
    const third = await held(); const r = await payment(third.booking.id);
    const close = await request('POST', `/payments/${r.id}/review`, manager, { decision: 'CLOSE_UNPAID', noFundsConfirmed: true, note: 'Bank checked; transfer was never received' });
    assert.equal(close.statusCode, 200, close.body); assert.equal((await stored(r.id)).status, 'FAILED');
    assert.equal((await bookingStored(third.booking.id)).status, 'CANCELLED');
  });

  await t.test('two successful payments for one hold apply only once; extra funds are reviewable', async () => {
    const { booking } = await held();
    const p = await payment(booking.id), q = await payment(booking.id, 'PAYSTACK_TEST'); answers.set(q.reference, { id: '91006' });
    const results = await Promise.all([manual(p.id, p.expectedAmountKobo), webhook(q.reference, '91006')]);
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200], results.map((r) => r.body).join('\n'));
    const records = await db.payment.findMany({ where: { bookingId: booking.id } });
    assert.equal(records.filter((r) => r.status === 'SUCCEEDED').length, 2);
    assert.equal(records.filter((r) => r.appliedAt !== null).length, 1);
    assert.equal(records.filter((r) => r.reviewReason === 'DUPLICATE_PAYMENT').length, 1);
    assert.equal(await db.auditLog.count({ where: { entityId: booking.id, action: 'booking.confirmed' } }), 1);
  });

  await t.test('provider transaction reuse is rejected independently of reference', async () => {
    const first = await held(), second = await held();
    const p = await payment(first.booking.id, 'PAYSTACK_TEST'), q = await payment(second.booking.id, 'PAYSTACK_TEST');
    answers.set(p.reference, { id: '91007' }); answers.set(q.reference, { id: '91007' });
    assert.equal((await verify(p.id)).statusCode, 200); assert.equal((await verify(q.id)).statusCode, 200);
    assert.equal((await stored(q.id)).status, 'REVIEW'); assert.equal((await stored(q.id)).reviewReason, 'PROVIDER_TRANSACTION_REUSED');
    assert.notEqual((await bookingStored(second.booking.id)).status, 'CONFIRMED');
  });

  await t.test('concurrent provider transaction reuse across properties records one success and one review', async () => {
    const first = await held(), second = await held();
    const p = await payment(first.booking.id, 'PAYSTACK_TEST'), q = await payment(second.booking.id, 'PAYSTACK_TEST');
    answers.set(p.reference, { id: '91999' }); answers.set(q.reference, { id: '91999' });
    const results = await Promise.all([webhook(p.reference, '91999'), webhook(q.reference, '91999')]);
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200], results.map((r) => r.body).join('\n'));
    const records = await db.payment.findMany({ where: { id: { in: [p.id, q.id] } } });
    assert.equal(records.filter((r) => r.status === 'SUCCEEDED' && r.appliedAt).length, 1);
    assert.equal(records.filter((r) => r.status === 'REVIEW' && r.reviewReason === 'PROVIDER_TRANSACTION_REUSED').length, 1);
  });

  // Build an already-expired, real snapshot-backed hold using the existing injected clock.
  // No trigger is disabled; raw payment fixtures represent initiation before process downtime.
  const expiredPayment = async () => {
    const property = await room();
    const now = new Date(Date.now() - 2 * 3600000);
    const service = new BookingService(db, context(), () => now);
    const booking = await service.create('HELD', { propertyId: property.id, guestName: 'Late guest', guestPhone: `+23480${String(++sequence).padStart(8, '0')}`,
      guestCount: 1, checkIn: '2027-01-08', checkOut: '2027-01-11' }, `expired-${++sequence}`) as { id: string };
    const reference = 'SLP-' + (++sequence).toString(16).padStart(32, '0');
    const quote = await bookingStored(booking.id);
    const p = await db.payment.create({ data: { tenantId: a.user.tenantId, bookingId: booking.id, reference, method: 'PAYSTACK_TEST', status: 'PENDING',
      expectedAmountKobo: quote.quoteTotalKobo, currency: 'NGN', idempotencyKey: `late-${++sequence}`, inputHash: 'test-fixture',
      customerEmail: 'guest@example.com', providerReference: reference } });
    initialized.set(reference, { reference, amountKobo: p.expectedAmountKobo, currency: p.currency, email: 'guest@example.com', tenantId: p.tenantId, bookingId: p.bookingId, paymentId: p.id });
    return { property, booking, p };
  };

  await t.test('late verified payment is recorded as paid conflict and cannot steal dates now occupied by a block', async () => {
    const { property, booking, p } = await expiredPayment();
    assert.equal((await request('POST', `/properties/${property.id}/blocks`, a, { startDate: '2027-01-08', endDate: '2027-01-11', reason: 'New valid occupant' })).statusCode, 201);
    answers.set(p.reference, { id: '91008' });
    const result = await webhook(p.reference, '91008'); assert.equal(result.statusCode, 200, result.body);
    assert.equal((await stored(p.id)).status, 'SUCCEEDED'); assert.equal((await stored(p.id)).reviewReason, 'HOLD_EXPIRED');
    assert.equal((await stored(p.id)).appliedAt, null); assert.equal((await bookingStored(booking.id)).status, 'PAID_CONFLICT');
    assert.equal(await db.availabilityBlock.count({ where: { propertyId: property.id } }), 1);
  });

  await t.test('property deactivation during verification preserves money and sends confirmation to review', async () => {
    const { property, booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST');
    let release!: () => void; verifyGate = new Promise<void>((resolve) => { release = resolve; });
    const count = verifyCount; answers.set(p.reference, { id: '91009' });
    const response = webhook(p.reference, '91009');
    while (verifyCount === count) await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      assert.equal((await request('POST', `/properties/${property.id}/blocks`, manager, { startDate: '2027-01-08', endDate: '2027-01-11', reason: 'Concurrent block attempt' })).statusCode, 409);
      assert.equal((await request('DELETE', `/properties/${property.id}`, manager)).statusCode, 200);
    } finally { release(); verifyGate = undefined; }
    const result = await response; assert.equal(result.statusCode, 200, result.body);
    assert.equal((await stored(p.id)).status, 'SUCCEEDED'); assert.equal((await stored(p.id)).reviewReason, 'PROPERTY_INACTIVE');
    assert.equal((await stored(p.id)).appliedAt, null); assert.notEqual((await bookingStored(booking.id)).status, 'CONFIRMED');
  });

  await t.test('provider confirmation audit failure leaves durable retryable event and rolls back proof/confirmation', async () => {
    const { booking } = await held(); const p = await payment(booking.id, 'PAYSTACK_TEST'); answers.set(p.reference, { id: '91010' });
    // Test-only audit fault in this generated schema; no production table or migration is changed.
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_test_confirmation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'booking.confirmed' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_test_confirmation_audit()`);
    try {
      assert.equal((await webhook(p.reference, '91010')).statusCode, 500);
      assert.notEqual((await stored(p.id)).status, 'SUCCEEDED'); assert.equal((await stored(p.id)).appliedAt, null);
      assert.equal((await bookingStored(booking.id)).status, 'VERIFICATION_PENDING');
      assert.equal(await db.auditLog.count({ where: { entityId: p.id, action: 'payment.provider_verified' } }), 0);
      assert.equal((await db.webhookEvent.findFirstOrThrow({ where: { eventId: `charge.success:${p.reference}:91010` } })).status, 'RECEIVED');
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_audit_failure ON "AuditLog"');
      await db.$executeRawUnsafe('DROP FUNCTION reject_test_confirmation_audit()');
    }
    assert.equal((await webhook(p.reference, '91010')).statusCode, 200);
    assert.equal((await bookingStored(booking.id)).status, 'CONFIRMED');
  });
});
