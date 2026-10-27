import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { BookingService } from '../services/booking-service.js';
import type { Permission } from '../services/authorization.js';
import { bookingParams } from '../services/booking-validation.js';
import { emptyQuery } from '../services/validation.js';

export const bookingRoutes: FastifyPluginAsync<{
  service: (request: FastifyRequest) => BookingService;
  permit: (permission: Permission) => preHandlerAsyncHookHandler;
}> = async (app, { service, permit }) => {
  for (const [path, kind] of [['/bookings', 'REQUESTED'], ['/holds', 'HELD']] as const) {
    app.post(path, { preHandler: permit('bookings:create') }, async (request, reply) => {
      emptyQuery.parse(request.query);
      return reply.code(201).send({ booking: await service(request).create(kind, request.body, request.headers['idempotency-key']) });
    });
  }
  app.get('/bookings', { preHandler: permit('bookings:read') }, async (request) => service(request).list(request.query));
  app.get('/bookings/:bookingId', { preHandler: permit('bookings:read') }, async (request) => {
    emptyQuery.parse(request.query);
    return { booking: await service(request).get(bookingParams.parse(request.params).bookingId) };
  });
  app.post('/bookings/:bookingId/extend', { preHandler: permit('bookings:create') }, async (request) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    return { booking: await service(request).extend(bookingParams.parse(request.params).bookingId) };
  });
  app.post('/bookings/:bookingId/cancel', { preHandler: permit('bookings:cancel') }, async (request) => {
    emptyQuery.parse(request.query);
    return { booking: await service(request).cancel(bookingParams.parse(request.params).bookingId, request.body) };
  });
};
