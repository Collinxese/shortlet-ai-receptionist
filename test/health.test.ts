import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('application health stays up while an unreachable database makes readiness fail safely', async (t) => {
  const app = await buildApp(loadConfig({
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable?connect_timeout=1'
  }), { logger: false });
  t.after(() => app.close());
  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');
  const ready = await app.inject('/api/ready');
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { ready: false, dependencies: { database: 'unavailable' } });
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  const protectedRoute = await app.inject('/api/team');
  assert.equal(protectedRoute.statusCode, 401);
  assert.equal(protectedRoute.headers['www-authenticate'], 'Bearer');
  const failedLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
    email: 'owner@example.com', password: 'some password'
  } });
  assert.equal(failedLogin.statusCode, 500);
  assert.deepEqual(failedLogin.json(), { error: 'INTERNAL_SERVER_ERROR' });
  assert.equal(failedLogin.headers['cache-control'], 'no-store');
});
