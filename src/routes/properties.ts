import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Permission } from '../services/authorization.js';
import type { TenantRepository } from '../services/tenant-repository.js';
import { blockParams, priceRuleParams, propertyParams } from '../services/property-validation.js';
import { emptyQuery } from '../services/validation.js';

export const propertyRoutes: FastifyPluginAsync<{
  repository: (request: FastifyRequest) => TenantRepository;
  permit: (permission: Permission) => preHandlerAsyncHookHandler;
}> = async (app, { repository, permit }) => {
  // Registered inside operatorRoutes: all routes inherit its session authentication.
  app.get('/properties', { preHandler: permit('properties:read') }, async (request) => repository(request).listProperties(request.query));
  app.post('/properties', { preHandler: permit('properties:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send({ property: await repository(request).createProperty(request.body) });
  });
  app.get('/properties/:propertyId', { preHandler: permit('properties:read') }, async (request) => {
    emptyQuery.parse(request.query);
    return { property: await repository(request).property(propertyParams.parse(request.params).propertyId) };
  });
  app.patch('/properties/:propertyId', { preHandler: permit('properties:write') }, async (request) => {
    emptyQuery.parse(request.query);
    return { property: await repository(request).updateProperty(propertyParams.parse(request.params).propertyId, request.body) };
  });
  app.delete('/properties/:propertyId', { preHandler: permit('properties:write') }, async (request) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    return { property: await repository(request).updateProperty(propertyParams.parse(request.params).propertyId, { isActive: false }) };
  });
  app.get('/properties/:propertyId/availability', { preHandler: permit('properties:read') }, async (request) =>
    repository(request).availability(propertyParams.parse(request.params).propertyId, request.query));
  app.get('/properties/:propertyId/blocks', { preHandler: permit('properties:read') }, async (request) =>
    repository(request).listBlocks(propertyParams.parse(request.params).propertyId, request.query));
  app.post('/properties/:propertyId/blocks', { preHandler: permit('availability:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send({ block: await repository(request).createBlock(propertyParams.parse(request.params).propertyId, request.body) });
  });
  app.delete('/properties/:propertyId/blocks/:blockId', { preHandler: permit('availability:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    const { propertyId, blockId } = blockParams.parse(request.params);
    await repository(request).removeBlock(propertyId, blockId);
    return reply.code(204).send();
  });
  app.get('/properties/:propertyId/price-overrides', { preHandler: permit('properties:read') }, async (request) =>
    repository(request).listPriceOverrides(propertyParams.parse(request.params).propertyId, request.query));
  app.post('/properties/:propertyId/price-overrides', { preHandler: permit('pricing:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send({ priceOverride: await repository(request).createPriceOverride(propertyParams.parse(request.params).propertyId, request.body) });
  });
  app.delete('/properties/:propertyId/price-overrides/:ruleId', { preHandler: permit('pricing:write') }, async (request, reply) => {
    emptyQuery.parse(request.query);
    if (request.body !== undefined) emptyQuery.parse(request.body);
    const { propertyId, ruleId } = priceRuleParams.parse(request.params);
    await repository(request).removePriceOverride(propertyId, ruleId);
    return reply.code(204).send();
  });
};
