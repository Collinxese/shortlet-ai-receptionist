import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { PaymentProvider } from '../services/payment-provider.js';
import { PaymentService } from '../services/payment-service.js';
import { emptyQuery } from '../services/validation.js';

export const paymentWebhookRoutes: FastifyPluginAsync<{
  db: PrismaClient; paymentProvider?: PaymentProvider; secret?: string;
}> = async (app, options) => {
  // Encapsulated parser preserves exactly the signed bytes, including JSON whitespace.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 131072 }, (_request, body, done) => done(null, body));
  app.post('/paystack', { bodyLimit: 131072 }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const result = await new PaymentService(options.db, options.paymentProvider).webhook(
      request.body as Buffer, request.headers['x-paystack-signature'], options.secret);
    // A non-2xx response asks Paystack to retry a durable, unresolved event.
    return reply.code(result.retry ? 503 : 200).send({ received: true, verificationPending: result.retry });
  });
};
