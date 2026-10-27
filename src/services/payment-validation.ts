import { z } from 'zod';
import { id, email, name } from './validation.js';

export const paymentParams = z.strictObject({ paymentId: id });
export const bankTransferBody = z.strictObject({ enabled: z.boolean(), bankName: name, accountName: name,
  accountNumber: z.string().regex(/^[0-9]{10}$/) });
export const createPaymentBody = z.discriminatedUnion('method', [
  z.strictObject({ bookingId: id, method: z.literal('MANUAL_TRANSFER') }),
  z.strictObject({ bookingId: id, method: z.literal('PAYSTACK_TEST'), email })
]);
export const manualVerificationBody = z.strictObject({
  confirmedAmountKobo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  receiptReference: z.string().trim().min(3).max(120),
  receiptConfirmed: z.literal(true), note: z.string().trim().min(1).max(500)
});
export const paymentReviewBody = z.strictObject({ note: z.string().trim().min(1).max(500),
  decision: z.enum(['NOTE', 'CLOSE_UNPAID']).default('NOTE'), noFundsConfirmed: z.literal(true).optional()
}).refine((value) => value.decision !== 'CLOSE_UNPAID' || value.noFundsConfirmed === true);
export const paymentListQuery = z.strictObject({ bookingId: id.optional(),
  status: z.enum(['INITIALIZING', 'PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'REVIEW']).optional(),
  review: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0)
});
