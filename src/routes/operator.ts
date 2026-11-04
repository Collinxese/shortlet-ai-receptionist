import type { WhatsAppOwnership } from '../services/whatsapp-ownership.js';
import { whatsappConnectionRoutes } from './whatsapp-connections.js';
import { WhatsAppConnections } from '../services/whatsapp-connections.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { hasPermission, type Permission } from '../services/authorization.js';
import type { AuthContext, AuthenticationService } from '../services/authentication.js';
import { HttpError } from '../services/errors.js';
import { TenantRepository } from '../services/tenant-repository.js';
import { auditQuery, createTeamBody, emptyQuery, updateTeamBody, updateTenantBody, userParams } from '../services/validation.js';
import { propertyRoutes } from './properties.js';
import { bookingRoutes } from './bookings.js';
import { BookingService } from '../services/booking-service.js';
import { PaymentService } from '../services/payment-service.js';
import type { PaymentProvider } from '../services/payment-provider.js';
import { paymentRoutes } from './payments.js';
import { usageRoutes } from './usage.js';
import { UsageService } from '../services/usage-service.js';
import type { UsageRuntime } from '../services/usage-validation.js';
import { conversationRoutes } from './conversations.js';
import { ConversationService } from '../services/conversation-service.js';
import type { ConversationModel } from '../services/conversation-model.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
}

export const operatorRoutes: FastifyPluginAsync<{ db: PrismaClient; authentication: AuthenticationService; paymentProvider?: PaymentProvider;
  whatsappOwnership:WhatsAppOwnership; conversationModel: ConversationModel; modelTimeoutMs: number; usageRuntime: UsageRuntime }> = async (app, options) => {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = await options.authentication.authenticate(request.headers.authorization);
  });
  function requireAuth(request: FastifyRequest): AuthContext {
    if (!request.auth) throw new HttpError(401, 'UNAUTHORIZED');
    return request.auth;
  }
  const permit = (permission: Permission) => async (request: FastifyRequest) => {
    if (!hasPermission(requireAuth(request).user.role, permission)) throw new HttpError(403, 'FORBIDDEN');
  };
  const repository = (request: FastifyRequest) => new TenantRepository(options.db, requireAuth(request));

  await app.register(whatsappConnectionRoutes, { service: r => new WhatsAppConnections(options.db, requireAuth(r),options.whatsappOwnership), permit });
  await app.register(propertyRoutes, { repository, permit });
  await app.register(bookingRoutes, { service: (request) => new BookingService(options.db, requireAuth(request)), permit });
  await app.register(paymentRoutes, { service: (request) => new PaymentService(options.db, options.paymentProvider, requireAuth(request)), permit });
  await app.register(conversationRoutes, { service: (request) => new ConversationService(options.db,requireAuth(request),options.conversationModel,options.modelTimeoutMs,undefined,options.usageRuntime), permit });

  await app.register(usageRoutes, { service: (request) => new UsageService(options.db,requireAuth(request),options.usageRuntime), permit });

  app.get('/auth/me', async (request) => {
    emptyQuery.parse(request.query);
    return { user: requireAuth(request).user };
  });
  app.post('/auth/logout', async (request, reply) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    await options.authentication.logout(requireAuth(request));
    return reply.code(204).send();
  });
  app.get('/tenant', { preHandler: permit('dashboard:read') }, async (request) => {
    emptyQuery.parse(request.query);
    return { tenant: await repository(request).tenant() };
  });
  app.patch('/tenant', { preHandler: permit('settings:write') }, async (request) => {
    emptyQuery.parse(request.query);
    return { tenant: await repository(request).renameTenant(updateTenantBody.parse(request.body).name) };
  });
  app.get('/team', { preHandler: permit('team:read') }, async (request) => {
    emptyQuery.parse(request.query);
    return { users: await repository(request).team() };
  });
  app.get('/team/:userId', { preHandler: permit('team:read') }, async (request) => {
    emptyQuery.parse(request.query);
    const { userId } = userParams.parse(request.params);
    return { user: await repository(request).teamMember(userId) };
  });
  app.post('/team', { preHandler: permit('team:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const user = await repository(request).createTeamMember(createTeamBody.parse(request.body));
    return reply.code(201).send({ user });
  });
  app.patch('/team/:userId', { preHandler: permit('team:write') }, async (request) => {
    emptyQuery.parse(request.query);
    const { userId } = userParams.parse(request.params);
    return { user: await repository(request).updateTeamMember(userId, updateTeamBody.parse(request.body)) };
  });
  app.get('/audit-logs', { preHandler: permit('audit:read') }, async (request) => {
    const { limit } = auditQuery.parse(request.query);
    return { events: await repository(request).auditLogs(limit) };
  });
};
