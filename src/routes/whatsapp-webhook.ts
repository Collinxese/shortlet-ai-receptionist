import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { WhatsAppOwnership } from '../services/whatsapp-ownership.js';
import { WhatsAppWebhook } from '../services/whatsapp-webhook.js';
import { matchesToken, verificationQuery } from '../services/whatsapp-validation.js';
import { HttpError } from '../services/errors.js';
import { emptyQuery } from '../services/validation.js';
export const whatsappWebhookRoutes: FastifyPluginAsync<{db:PrismaClient;ownership:WhatsAppOwnership;enabled:boolean;secret?:string;verifyToken?:string}> = async(app,options)=>{
  const configured=()=>{if(!options.enabled || !options.secret || !options.verifyToken) throw new HttpError(503,'WHATSAPP_WEBHOOK_UNAVAILABLE');};
  app.get('/whatsapp',async(request,reply)=>{
    configured(); const query=verificationQuery.safeParse(request.query);
    if(!query.success || !matchesToken(query.data['hub.verify_token'],options.verifyToken!)) throw new HttpError(403,'WEBHOOK_VERIFICATION_FAILED');
    return reply.type('text/plain').send(query.data['hub.challenge']);
  });
  // Encapsulation leaves JSON parsing on authenticated routes and Paystack unchanged.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:131072},(_request,body,done)=>done(null,body));
  app.post('/whatsapp',{bodyLimit:131072},async request=>{
    configured();emptyQuery.parse(request.query);
    return new WhatsAppWebhook(options.db,options.secret!,undefined,options.ownership).receive(request.body as Buffer,request.headers['x-hub-signature-256']);
  });
};
