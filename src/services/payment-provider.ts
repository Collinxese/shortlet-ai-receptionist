import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type ProviderInput = {
  reference: string; amountKobo: bigint; currency: string; email: string;
  tenantId: string; bookingId: string; paymentId: string;
};
export type VerifiedTransaction = {
  id: string; domain: string; status: string; reference: string; amountKobo: bigint; currency: string;
  paidAt: string | null; metadata: { tenantId: string; bookingId: string; paymentId: string };
};
export interface PaymentProvider {
  initialize(input: ProviderInput): Promise<{ reference: string; authorizationUrl: string }>;
  verify(reference: string): Promise<VerifiedTransaction>;
}
export class ProviderUnavailable extends Error {
  constructor() { super('PROVIDER_UNAVAILABLE'); }
}
export const providerId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[0-9]{1,20}$/)]);
const metadata = z.object({ tenantId: z.string(), bookingId: z.string(), paymentId: z.string() });
const transaction = z.object({
  id: providerId, domain: z.string(), status: z.string(), reference: z.string(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.string(),
  paid_at: z.iso.datetime({ offset: true }).nullable(), metadata: z.unknown()
});

/** Fixed provider origin, test secret only, no card/authorization data persistence. */
export class PaystackTestProvider implements PaymentProvider {
  constructor(private readonly secret: string, private readonly transport: typeof fetch = fetch) {
    if (!/^sk_test_[A-Za-z0-9]+$/.test(secret)) throw new Error('PAYSTACK_TEST_KEY_REQUIRED');
  }
  private async call(path: string, body?: object): Promise<unknown> {
    try {
      const response = await this.transport(`https://api.paystack.co${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw new ProviderUnavailable();
      // Never log or persist the full provider body (it may contain card data).
      const result = z.object({ status: z.literal(true), data: z.unknown() }).parse(await response.json());
      return result.data;
    } catch { throw new ProviderUnavailable(); }
  }
  async initialize(input: ProviderInput) {
    const data = z.object({ reference: z.string(), authorization_url: z.url() }).parse(await this.call('/transaction/initialize', {
      reference: input.reference, email: input.email, amount: input.amountKobo.toString(), currency: input.currency,
      metadata: JSON.stringify({ tenantId: input.tenantId, bookingId: input.bookingId, paymentId: input.paymentId })
    }));
    const url = new URL(data.authorization_url);
    if (data.reference !== input.reference || url.origin !== 'https://checkout.paystack.com' || url.username || url.password) throw new ProviderUnavailable();
    return { reference: data.reference, authorizationUrl: url.toString() };
  }
  async verify(reference: string): Promise<VerifiedTransaction> {
    try {
      const data = transaction.parse(await this.call(`/transaction/verify/${encodeURIComponent(reference)}`));
      const details = metadata.parse(typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata);
      return { id: data.id, domain: data.domain, status: data.status, reference: data.reference,
        amountKobo: BigInt(data.amount), currency: data.currency, paidAt: data.paid_at, metadata: details };
    } catch { throw new ProviderUnavailable(); }
  }
}

export function validPaystackSignature(raw: Buffer, signature: unknown, secret: string | undefined): boolean {
  if (!Buffer.isBuffer(raw) || !secret || typeof signature !== 'string' || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  const expected = createHmac('sha512', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
