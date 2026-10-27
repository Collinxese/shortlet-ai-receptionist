import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { ConversationService } from '../services/conversation-service.js';
import type { Permission } from '../services/authorization.js';
import { conversationParams } from '../services/conversation-validation.js';
import { emptyQuery } from '../services/validation.js';

export const conversationRoutes: FastifyPluginAsync<{
  service: (request: FastifyRequest) => ConversationService;
  permit: (permission: Permission) => preHandlerAsyncHookHandler;
}> = async (app,{ service,permit }) => {
  app.post('/simulations/conversations',{ preHandler: permit('inbox:reply') },async(request,reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send({ conversation: await service(request).create(request.body,request.headers['idempotency-key']) });
  });
  app.post('/simulations/conversations/:conversationId/messages',{ preHandler: permit('inbox:reply'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },async(request) => {
    emptyQuery.parse(request.query);
    return service(request).send(conversationParams.parse(request.params).conversationId,request.body,request.headers['idempotency-key']);
  });
  app.get('/conversations',{ preHandler: permit('inbox:read') },async(request) => service(request).list(request.query));
  app.get('/conversations/:conversationId',{ preHandler: permit('inbox:read') },async(request) => {
    emptyQuery.parse(request.query);
    return { conversation: await service(request).get(conversationParams.parse(request.params).conversationId) };
  });
  app.get('/conversations/:conversationId/messages',{ preHandler: permit('inbox:read') },async(request) =>
    service(request).history(conversationParams.parse(request.params).conversationId,request.query));
  app.get('/conversations/:conversationId/escalations',{ preHandler: permit('inbox:read') },async(request) => {
    emptyQuery.parse(request.query);
    return { escalations: await service(request).escalations(conversationParams.parse(request.params).conversationId) };
  });
  app.patch('/conversations/:conversationId/handling',{ preHandler: permit('inbox:takeover') },async(request) => {
    emptyQuery.parse(request.query);
    return { conversation: await service(request).handling(conversationParams.parse(request.params).conversationId,request.body) };
  });
};
