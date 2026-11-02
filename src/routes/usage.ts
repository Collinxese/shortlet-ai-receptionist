import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { UsageService } from '../services/usage-service.js';
import type { Permission } from '../services/authorization.js';
import { usageQuery, modeParams, eventParams, inboundBody, reconciliationBody } from '../services/usage-validation.js';
import { emptyQuery } from '../services/validation.js';
export const usageRoutes: FastifyPluginAsync<{ service: (r: FastifyRequest) => UsageService;
  permit: (p: Permission) => preHandlerAsyncHookHandler }> = async(app,{service,permit}) => {
  app.get('/usage',{ preHandler: permit('usage:read') },async(r) => service(r).summary(usageQuery.parse(r.query).mode));
  app.get('/usage/events',{ preHandler: permit('usage:read') },async(r) => {
    const {mode,limit}=usageQuery.parse(r.query);return { events: await service(r).list(mode,limit) };
  });
  app.get('/usage/alerts',{ preHandler: permit('usage:read') },async(r) => {
    const {mode,limit}=usageQuery.parse(r.query);return { alerts: await service(r).alerts(mode,limit) };
  });
  app.get('/usage/events/:eventId',{ preHandler: permit('usage:read') },async(r) => {
    emptyQuery.parse(r.query);return { event: await service(r).get(eventParams.parse(r.params).eventId) };
  });
  app.put('/usage/policy/:mode',{ preHandler: permit('usage:write') },async(r) => {
    emptyQuery.parse(r.query);return { policy: await service(r).configure(modeParams.parse(r.params).mode,r.body) };
  });
  app.post('/usage/simulations',{ preHandler: permit('usage:write') },async(r) => {
    emptyQuery.parse(r.query);return { simulated: true, event: await service(r).simulate(r.body,r.headers['idempotency-key']) };
  });
  app.post('/usage/simulations/inbound',{ preHandler: permit('usage:write') },async(r) => {
    emptyQuery.parse(r.query);return { simulated: true, receipt: await service(r).recordInbound(inboundBody.parse(r.body)) };
  });
  app.post('/usage/simulations/:eventId/reconcile',{ preHandler: permit('usage:write') },async(r) => {
    emptyQuery.parse(r.query);const v=reconciliationBody.parse(r.body);
    return { simulated: true, event: await service(r).reconcileSimulation(eventParams.parse(r.params).eventId,v.inputTokens,v.outputTokens) };
  });
  app.post('/usage/recover',{ preHandler: permit('usage:write') },async(r) => {
    emptyQuery.parse(r.query);emptyQuery.parse(r.body ?? {});return service(r).recover();
  });
};
