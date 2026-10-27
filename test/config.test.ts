import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('configuration requires PostgreSQL and bounds session lifetime and rate limits', () => {
  const env = { DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/shortlet_test' };
  assert.equal(loadConfig(env).SESSION_TTL_HOURS, 8);
  assert.equal(loadConfig(env).AUTH_RATE_LIMIT_MAX, 10);
  for (const value of ['0', '25', 'eight']) {
    assert.throws(() => loadConfig({ ...env, SESSION_TTL_HOURS: value }), /SESSION_TTL_HOURS/);
  }
  assert.throws(() => loadConfig({ ...env, AUTH_RATE_LIMIT_MAX: '0' }), /AUTH_RATE_LIMIT_MAX/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: 'mysql://user:secret@localhost/db' }), (error: Error) => {
    assert.equal(error.message.includes('secret'), false);
    return error.message.includes('DATABASE_URL');
  });
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});
