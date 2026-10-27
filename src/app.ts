import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient, Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { operatorRoutes } from './routes/operator.js';
import { AuthenticationService } from './services/authentication.js';
import { HttpError } from './services/errors.js';
import { PaystackTestProvider, type PaymentProvider } from './services/payment-provider.js';
import { paymentWebhookRoutes } from './routes/payment-webhook.js';
import { MockConversationModel, OpenAIConversationModel, type ConversationModel } from './services/conversation-model.js';

export async function buildApp(config: AppConfig, options: { db?: PrismaClient; logger?: boolean; paymentProvider?: PaymentProvider; conversationModel?: ConversationModel } = {}) {
  const db = options.db ?? new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']
    },
    bodyLimit: 16_384,
    trustProxy: false
  });
  // Install the safe error handler before plugins so every route inherits it.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(error.statusCode).send({ error: error.code });
    }
    if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    if ((error instanceof Prisma.PrismaClientKnownRequestError && ['P2004', 'P2010'].includes(error.code)) ||
        error instanceof Prisma.PrismaClientUnknownRequestError) {
      // Named exclusion constraints are a final guard against concurrent database writers.
      // Inspect internally, but never send PostgreSQL details or query values to clients.
      const details = error.message + ('meta' in error ? JSON.stringify(error.meta) : '');
      const conflict = details.includes('AvailabilityBlock_no_overlap') ? 'BLOCK_OVERLAP' :
        details.includes('PriceRule_dates_no_overlap') ? 'PRICE_OVERRIDE_OVERLAP' :
        details.includes('Booking_guest_active_hold') ? 'GUEST_ACTIVE_HOLD' :
        details.includes('Occupancy_review_required') ? 'OCCUPANCY_REVIEW_REQUIRED' :
        details.includes('Occupancy_property_inactive') ? 'PROPERTY_INACTIVE' :
        details.includes('Block_booking_conflict') ? 'BOOKING_OVERLAP' :
        /Booking_durable_no_overlap|Booking_occupancy_conflict|Booking_block_conflict/.test(details) ? 'DATES_UNAVAILABLE' :
        details.includes('Booking_extension_invalid') ? 'HOLD_NOT_EXTENDABLE' :
        details.includes('Booking_expiry_invalid') ? 'HOLD_NOT_EXPIRED' : undefined;
      if (conflict) return reply.code(409).send({ error: conflict });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return reply.code(409).send({ error: 'WRITE_CONFLICT_RETRY' });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'RATE_LIMITED' : status === 413 ? 'PAYLOAD_TOO_LARGE' :
        status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST';
      return reply.code(status).send({ error: code });
    }
    // Raw Prisma errors can contain query values and credentials.
    request.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    return reply.code(500).send({ error: 'INTERNAL_SERVER_ERROR' });
  });
  // Lazy connection keeps liveness available during an outage; readiness checks the DB.
  app.addHook('onClose', async () => { await db.$disconnect(); });
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const authentication = new AuthenticationService(db, config.SESSION_TTL_HOURS);
  const paymentProvider = config.PAYSTACK_TEST_ENABLED ? options.paymentProvider ?? new PaystackTestProvider(config.PAYSTACK_TEST_SECRET_KEY!) : undefined;
  const conversationModel = options.conversationModel ?? (config.AI_PROVIDER === 'openai' ? new OpenAIConversationModel(config.OPENAI_API_KEY!,config.AI_MODEL!) :
    config.AI_PROVIDER === 'mock' ? new MockConversationModel() : { name: 'disabled', async plan() { throw new Error('MODEL_UNAVAILABLE'); } });
  await app.register(healthRoutes, { prefix: '/api', db });
  await app.register(authRoutes, { prefix: '/api/auth', authentication, authRateLimitMax: config.AUTH_RATE_LIMIT_MAX });
  await app.register(operatorRoutes, { prefix: '/api', db, authentication, paymentProvider, conversationModel, modelTimeoutMs: config.AI_TIMEOUT_MS });
  await app.register(paymentWebhookRoutes, { prefix: '/api/webhooks', db, paymentProvider, secret: config.PAYSTACK_TEST_SECRET_KEY });
  return app;
}
