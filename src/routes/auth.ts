import type { FastifyPluginAsync } from 'fastify';
import type { AuthenticationService } from '../services/authentication.js';
import { emptyQuery, loginBody, registrationBody } from '../services/validation.js';

export const authRoutes: FastifyPluginAsync<{ authentication: AuthenticationService; authRateLimitMax: number }> = async (app, options) => {
  const auth = options.authentication;
  // A shared IP bucket covers both routes; alternating routes cannot double the allowance.
  const limiter = app.rateLimit({ max: options.authRateLimitMax, timeWindow: '1 minute' });
  const routeOptions = { config: { rateLimit: false as const }, onRequest: limiter };
  app.post('/register', routeOptions, async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply.code(201).send(await auth.register(registrationBody.parse(request.body)));
  });
  app.post('/login', routeOptions, async (request) => {
    emptyQuery.parse(request.query);
    return auth.login(loginBody.parse(request.body));
  });
};
