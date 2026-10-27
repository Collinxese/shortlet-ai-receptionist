import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { PaymentService } from '../services/payment-service.js';
import type { Permission } from '../services/authorization.js';
import { paymentParams } from '../services/payment-validation.js';
import { emptyQuery } from '../services/validation.js';

export const paymentRoutes: FastifyPluginAsync<{
  service: (request: FastifyRequest) => PaymentService;
  permit: (permission: Permission) => preHandlerAsyncHookHandler;
}> = async (app, { service, permit }) => {
  app.get('/payment-settings/bank-transfer', { preHandler: permit('payment-settings:write') }, async (request) => {
    emptyQuery.parse(request.query);
    return { settings: await service(request).bankSettings() };
  });
  app.put('/payment-settings/bank-transfer', { preHandler: permit('payment-settings:write') }, async (request) => {
    emptyQuery.parse(request.query);
    return { settings: await service(request).configureBank(request.body) };
  });
  app.post('/payments', { preHandler: permit('payments:create') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send({ payment: await service(request).create(request.body, request.headers['idempotency-key']) });
  });
  app.get('/payments', { preHandler: permit('payments:read') }, async (request) => service(request).list(request.query));
  app.get('/payments/:paymentId', { preHandler: permit('payments:read') }, async (request) => {
    emptyQuery.parse(request.query);
    return { payment: await service(request).get(paymentParams.parse(request.params).paymentId) };
  });
  app.post('/payments/:paymentId/verify-manual', { preHandler: permit('payments:verify'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const result = await service(request).verifyManual(paymentParams.parse(request.params).paymentId, request.body);
    return reply.code(result.error ? 409 : 200).send(result);
  });
  app.post('/payments/:paymentId/verify', { preHandler: permit('payments:verify'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    const result = await service(request).verifyOnline(paymentParams.parse(request.params).paymentId);
    return { payment: result.payment, verificationPending: result.retry };
  });
  app.post('/payments/:paymentId/review', { preHandler: permit('payments:verify') }, async (request) => {
    emptyQuery.parse(request.query);
    return { payment: await service(request).review(paymentParams.parse(request.params).paymentId, request.body) };
  });
};
