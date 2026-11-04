import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { WhatsAppConnections } from '../services/whatsapp-connections.js';
import type { Permission } from '../services/authorization.js';
import { connectionParams } from '../services/whatsapp-validation.js';
import { emptyQuery } from '../services/validation.js';
export const whatsappConnectionRoutes: FastifyPluginAsync<{service:(r:FastifyRequest)=>WhatsAppConnections;
  permit:(p:Permission)=>preHandlerAsyncHookHandler}> = async(app,{service,permit})=>{
  app.get('/whatsapp/connections',{preHandler:permit('whatsapp:manage')},async r=>service(r).list(r.query));
  app.post('/whatsapp/connections',{preHandler:permit('whatsapp:manage')},async(r,reply)=>{
    emptyQuery.parse(r.query);return reply.code(201).send({connection:await service(r).create(r.body)});
  });
  app.post('/whatsapp/connections/:connectionId/verify',{preHandler:permit('whatsapp:manage'),config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async r=>{
    emptyQuery.parse(r.query);emptyQuery.parse(r.body ?? {});return {connection:await service(r).verify(connectionParams.parse(r.params).connectionId)};
  });
  app.patch('/whatsapp/connections/:connectionId',{preHandler:permit('whatsapp:manage')},async r=>{
    emptyQuery.parse(r.query);return {connection:await service(r).update(connectionParams.parse(r.params).connectionId,r.body)};
  });
};
