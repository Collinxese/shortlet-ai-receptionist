import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PaystackTestProvider, ProviderUnavailable, validPaystackSignature } from '../src/services/payment-provider.js';
import { loadConfig } from '../src/config.js';

const secret = 'sk_test_dummyunitkey';
test('Paystack configuration rejects live keys, requires enabled test credentials, defaults off and never exposes the value', () => {
  const DATABASE_URL = 'postgresql://test@localhost/test';
  assert.equal(loadConfig({ DATABASE_URL }).PAYSTACK_TEST_ENABLED, false);
  for (const PAYSTACK_TEST_SECRET_KEY of ['sk_live_example', 'secret-invalid-value']) {
    assert.throws(() => loadConfig({ DATABASE_URL, PAYSTACK_TEST_SECRET_KEY }), (error: Error) =>
      error.message === 'Invalid configuration: PAYSTACK_TEST_SECRET_KEY');
    assert.throws(() => new PaystackTestProvider(PAYSTACK_TEST_SECRET_KEY), /PAYSTACK_TEST_KEY_REQUIRED/);
  }
  assert.throws(() => loadConfig({ DATABASE_URL, PAYSTACK_TEST_ENABLED: 'true' }), /PAYSTACK_TEST_SECRET_KEY/);
});

test('webhook signature validates the original bytes using HMAC SHA512, not reserialized JSON', () => {
  const bytes = Buffer.from('{ "event": "charge.success" }\n');
  const signature = createHmac('sha512', secret).update(bytes).digest('hex');
  assert.equal(validPaystackSignature(bytes, signature, secret), true);
  assert.equal(validPaystackSignature(Buffer.from(JSON.stringify(JSON.parse(bytes.toString()))), signature, secret), false);
  for (const value of [undefined, [], 'invalid', '0'.repeat(128), signature + '00']) assert.equal(validPaystackSignature(bytes, value, secret), false);
  assert.equal(validPaystackSignature(bytes, signature, undefined), false);
  assert.equal(validPaystackSignature(undefined as unknown as Buffer, signature, secret), false);
});

test('test adapter initializes with exact kobo, fixed origin, association metadata and no redirect', async () => {
  const input = { reference: 'SLP-' + 'a'.repeat(32), amountKobo: 9007199254740991n,
    email: 'guest@example.com', currency: 'NGN', tenantId: 'tenant', bookingId: 'booking', paymentId: 'payment' };
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
    const payload = JSON.parse(options!.body as string);
    assert.equal(payload.amount, '9007199254740991');
    assert.deepEqual(JSON.parse(payload.metadata), { tenantId: 'tenant', bookingId: 'booking', paymentId: 'payment' });
    return Response.json({ status: true, data: { reference: input.reference, authorization_url: 'https://checkout.paystack.com/test' } });
  };
  const result = await new PaystackTestProvider(secret, transport).initialize(input);
  assert.equal(result.reference, input.reference);
  for (const [reference, authorization_url] of [['wrong', result.authorizationUrl], [input.reference, 'https://evil.example/checkout']]) {
    await assert.rejects(new PaystackTestProvider(secret, async () => Response.json({ status: true, data: { reference, authorization_url } })).initialize(input));
  }
});

test('provider verification preserves large string transaction IDs and rejects unsafe amounts/IDs and malformed proof', async () => {
  const data = { id: '18446744073709551615', domain: 'test', status: 'success', reference: 'SLP-test', amount: 12301,
    currency: 'NGN', paid_at: '2026-10-25T12:00:00Z', metadata: { tenantId: 'tenant', bookingId: 'booking', paymentId: 'payment' },
    authorization: { card_number: 'must-not-escape' } };
  const adapter = (patch = {}) => new PaystackTestProvider(secret, async () => Response.json({ status: true, data: { ...data, ...patch } }));
  const result = await adapter().verify('SLP-test');
  assert.equal(result.id, data.id);
  assert.equal(result.amountKobo, 12301n);
  assert.equal('authorization' in result, false);
  for (const patch of [{ amount: 1.1 }, { amount: 9007199254740992 }, { id: 9007199254740992 }, { metadata: {} }, { paid_at: 'not-a-date' }]) {
    await assert.rejects(adapter(patch).verify('SLP-test'), ProviderUnavailable);
  }
  await assert.rejects(new PaystackTestProvider(secret, async () => { throw new Error(secret); }).verify('ref'),
    (error: Error) => error.message === 'PROVIDER_UNAVAILABLE');
  await assert.rejects(new PaystackTestProvider(secret, async () => Response.json({ status: false })).verify('ref'), ProviderUnavailable);
});
