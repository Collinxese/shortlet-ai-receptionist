import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { hashSessionToken } from '../../src/services/authentication.js';

type Account = { accessToken: string; expiresAt: string; user: {
  id: string; tenantId: string; name: string; email: string; role: string; isActive: boolean
} };

test('Phase 1 against migrated PostgreSQL', async (t) => {
  // Explicit opt-in only: never fall back to the application's DATABASE_URL.
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL test database.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  const schema = `phase1_test_${randomBytes(8).toString('hex')}`;
  url.searchParams.set('schema', schema);
  const databaseUrl = url.toString();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let app: FastifyInstance | undefined;
  t.after(async () => {
    try {
      await app?.close();
      // Identifier is generated above, never derived from request or environment input.
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db.$disconnect();
    }
  });
  const migrationOutput = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8'
  });
  assert.match(migrationOutput, /All migrations have been successfully applied/);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_RATE_LIMIT_MAX: '30' });
  app = await buildApp(config, { db, logger: false });
  const api = app;
  let client = 1;
  // Independent clients keep validation/auth tests separate from the explicit rate-limit test.
  const request = (method: HTTPMethods, path: string, token?: string, payload?: object) => api.inject({
    method, url: `/api${path}`, remoteAddress: `198.51.100.${client++ % 250 + 1}`,
    headers: token ? { authorization: `Bearer ${token}` } : {}, payload
  });
  const password = 'test-only-long-password-123';
  const register = async (suffix: string): Promise<Account> => {
    const response = await request('POST', '/auth/register', undefined, {
      tenantName: `Tenant ${suffix}`, name: `Owner ${suffix}`, email: `owner-${suffix}@example.com`, password
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<Account>();
  };
  const login = async (email: string): Promise<Account> => {
    const response = await request('POST', '/auth/login', undefined, { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Account>();
  };
  const createMember = async (owner: Account, role: 'MANAGER' | 'RECEPTIONIST', suffix: string): Promise<Account> => {
    const response = await request('POST', '/team', owner.accessToken, {
      name: suffix, email: `${suffix}@example.com`, password, role
    });
    assert.equal(response.statusCode, 201, response.body);
    const account = await login(`${suffix}@example.com`);
    assert.equal(account.user.tenantId, owner.user.tenantId);
    return account;
  };

  const a = await register('a');
  const b = await register('b');
  const manager = await createMember(a, 'MANAGER', 'manager-a');
  const receptionist = await createMember(a, 'RECEPTIONIST', 'reception-a');
  const foreignManager = await createMember(b, 'MANAGER', 'manager-b');

  await t.test('registration stores Argon2id hashes, digested sessions and an owner audit atomically', async () => {
    const stored = await db.user.findUniqueOrThrow({ where: { id: a.user.id } });
    assert.match(stored.passwordHash, /^\$argon2id\$/);
    assert.notEqual(stored.passwordHash, password);
    assert.equal(a.user.role, 'OWNER');
    assert.equal(JSON.stringify(a).includes('passwordHash'), false);
    assert.match(a.accessToken, /^[A-Za-z0-9_-]{43}$/);
    const session = await db.authSession.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(a.accessToken) } });
    assert.notEqual(session.tokenHash, a.accessToken);
    assert.equal(session.tenantId, a.user.tenantId);
    assert.ok(new Date(a.expiresAt).getTime() > Date.now());
    assert.ok(new Date(a.expiresAt).getTime() <= Date.now() + 8 * 60 * 60 * 1000);
    assert.equal(await db.auditLog.count({ where: { tenantId: a.user.tenantId, action: 'operator.registered' } }), 1);
    const before = await db.tenant.count();
    const duplicate = await request('POST', '/auth/register', undefined, {
      tenantName: 'Must roll back', name: 'Duplicate', email: ' OWNER-A@EXAMPLE.COM ', password
    });
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(duplicate.json(), { error: 'ACCOUNT_UNAVAILABLE' });
    assert.equal(await db.tenant.count(), before);
  });

  await t.test('login normalizes email and uses identical errors for wrong, unknown and disabled accounts', async () => {
    const session = await login(' OWNER-A@EXAMPLE.COM ');
    assert.equal(session.user.id, a.user.id);
    for (const [email, value] of [['owner-a@example.com', 'wrong password'], ['unknown@example.com', password]]) {
      const response = await request('POST', '/auth/login', undefined, { email, password: value });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'INVALID_CREDENTIALS' });
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  await t.test('all protected endpoints require a valid server session and ignore forged identity headers', async () => {
    for (const [method, path] of [
      ['GET', '/auth/me'], ['POST', '/auth/logout'], ['GET', '/tenant'], ['PATCH', '/tenant'],
      ['GET', '/team'], ['GET', `/team/${b.user.id}`], ['POST', '/team'],
      ['PATCH', `/team/${b.user.id}`], ['GET', '/audit-logs']
    ] as [HTTPMethods, string][]) {
      assert.equal((await request(method, path)).statusCode, 401, `${method} ${path}`);
    }
    for (const token of ['invalid', 'a'.repeat(43), a.accessToken.slice(0, 42) + (a.accessToken.endsWith('x') ? 'y' : 'x')]) {
      assert.equal((await request('GET', '/auth/me', token)).statusCode, 401);
    }
    const spoofed = await api.inject({ url: '/api/auth/me', headers: {
      'x-user-id': a.user.id, 'x-tenant-id': a.user.tenantId, 'x-role': 'OWNER'
    } });
    assert.equal(spoofed.statusCode, 401);
    const authenticated = await api.inject({ url: '/api/tenant', headers: {
      authorization: `Bearer ${a.accessToken}`, 'x-tenant-id': b.user.tenantId
    } });
    assert.equal(authenticated.json().tenant.id, a.user.tenantId);
  });

  await t.test('tenant A cannot read or modify tenant B team members, including guessed IDs', async () => {
    const missingId = 'c' + 'z'.repeat(24);
    for (const [source, target] of [[a, foreignManager], [b, manager]] as const) {
      for (const targetId of [target.user.id, missingId]) {
        const read = await request('GET', `/team/${targetId}`, source.accessToken);
        assert.equal(read.statusCode, 404);
        assert.deepEqual(read.json(), { error: 'NOT_FOUND' });
        const update = await request('PATCH', `/team/${targetId}`, source.accessToken, { isActive: false });
        assert.equal(update.statusCode, 404);
        assert.deepEqual(update.json(), { error: 'NOT_FOUND' });
      }
    }
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: foreignManager.user.id } })).isActive, true);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: manager.user.id } })).isActive, true);
  });

  await t.test('lists, audit records and settings stay scoped to the session tenant', async () => {
    for (const owner of [a, b]) {
      const team = await request('GET', '/team', owner.accessToken);
      assert.equal(team.statusCode, 200);
      assert.ok(team.json().users.every((user: { tenantId: string }) => user.tenantId === owner.user.tenantId));
      assert.equal(team.body.includes('passwordHash'), false);
      const audit = await request('GET', '/audit-logs?limit=100', owner.accessToken);
      assert.equal(audit.statusCode, 200);
      assert.ok(audit.json().events.length > 0);
      assert.ok(audit.json().events.every((entry: { tenantId: string }) => entry.tenantId === owner.user.tenantId));
      assert.equal(audit.body.includes(password), false);
      assert.equal(audit.body.includes(owner.accessToken), false);
    }
    assert.equal((await request('PATCH', '/tenant', a.accessToken, { name: 'Renamed A' })).statusCode, 200);
    assert.equal((await request('GET', '/tenant', b.accessToken)).json().tenant.name, 'Tenant b');
    assert.equal((await request('GET', `/team?tenantId=${b.user.tenantId}`, a.accessToken)).statusCode, 400);
    assert.equal((await request('GET', `/audit-logs?tenantId=${b.user.tenantId}`, a.accessToken)).statusCode, 400);
    assert.equal((await request('PATCH', '/tenant', a.accessToken, { name: 'Injected', tenantId: b.user.tenantId })).statusCode, 400);
    assert.equal((await request('POST', '/team', a.accessToken, {
      name: 'Injected', email: 'injected@example.com', password, role: 'MANAGER', tenantId: b.user.tenantId
    })).statusCode, 400);
  });

  await t.test('server enforces the existing role matrix and denies privilege escalation', async () => {
    assert.equal((await request('GET', '/team', manager.accessToken)).statusCode, 200);
    assert.equal((await request('GET', '/audit-logs', manager.accessToken)).statusCode, 200);
    for (const actor of [manager, receptionist]) {
      assert.equal((await request('PATCH', '/tenant', actor.accessToken, { name: 'Denied' })).statusCode, 403);
      assert.equal((await request('POST', '/team', actor.accessToken, {
        name: 'Denied', email: 'denied@example.com', password, role: 'MANAGER'
      })).statusCode, 403);
      assert.equal((await request('PATCH', `/team/${receptionist.user.id}`, actor.accessToken, { role: 'MANAGER' })).statusCode, 403);
      assert.equal((await request('GET', '/tenant', actor.accessToken)).statusCode, 200);
    }
    assert.equal((await request('GET', '/team', receptionist.accessToken)).statusCode, 403);
    assert.equal((await request('GET', '/audit-logs', receptionist.accessToken)).statusCode, 403);
    assert.equal((await request('PATCH', `/team/${a.user.id}`, a.accessToken, { isActive: false })).statusCode, 403);
    assert.equal((await request('PATCH', `/team/${receptionist.user.id}`, a.accessToken, { role: 'OWNER' })).statusCode, 400);
    assert.equal((await request('POST', '/auth/register', undefined, {
      tenantName: 'Injected', name: 'Injected', email: 'owner-injection@example.com', password, role: 'OWNER'
    })).statusCode, 400);
  });

  await t.test('role changes affect existing sessions immediately; deactivation revokes sessions', async () => {
    const changed = await request('PATCH', `/team/${manager.user.id}`, a.accessToken, { role: 'RECEPTIONIST' });
    assert.equal(changed.statusCode, 200);
    assert.equal((await request('GET', '/team', manager.accessToken)).statusCode, 403);
    assert.equal((await request('GET', '/auth/me', manager.accessToken)).json().user.role, 'RECEPTIONIST');
    assert.equal((await request('PATCH', `/team/${receptionist.user.id}`, a.accessToken, { isActive: false })).statusCode, 200);
    assert.equal(await db.authSession.count({ where: { tenantId: a.user.tenantId, userId: receptionist.user.id } }), 0);
    assert.equal((await request('GET', '/auth/me', receptionist.accessToken)).statusCode, 401);
    const disabledLogin = await request('POST', '/auth/login', undefined, { email: receptionist.user.email, password });
    assert.equal(disabledLogin.statusCode, 401);
    assert.deepEqual(disabledLogin.json(), { error: 'INVALID_CREDENTIALS' });
    assert.equal((await request('PATCH', `/team/${receptionist.user.id}`, a.accessToken, { isActive: true })).statusCode, 200);
    assert.equal((await request('GET', '/auth/me', receptionist.accessToken)).statusCode, 401);
  });

  await t.test('expired, logged-out and inactive-user sessions are rejected without affecting other sessions', async () => {
    const expired = await login(a.user.email);
    await db.authSession.update({ where: { tokenHash: hashSessionToken(expired.accessToken) }, data: { expiresAt: new Date(Date.now() - 1) } });
    assert.equal((await request('GET', '/auth/me', expired.accessToken)).statusCode, 401);
    const logout = await login(a.user.email);
    assert.equal((await request('POST', '/auth/logout', logout.accessToken)).statusCode, 204);
    assert.equal((await request('GET', '/auth/me', logout.accessToken)).statusCode, 401);
    assert.equal((await request('GET', '/auth/me', a.accessToken)).statusCode, 200);
    await db.user.update({ where: { id: foreignManager.user.id }, data: { isActive: false } });
    assert.equal((await request('GET', '/auth/me', foreignManager.accessToken)).statusCode, 401);
    await db.user.update({ where: { id: foreignManager.user.id }, data: { isActive: true } });
  });

  await t.test('invalid bodies, IDs, JSON, content types and oversized requests return safe client errors', async () => {
    for (const payload of [
      {}, { email: 'bad-email', password }, { email: a.user.email, password: 123 },
      { email: a.user.email, password, tenantId: b.user.tenantId },
      { email: a.user.email, password, role: 'OWNER' }, { email: a.user.email, password: 'x'.repeat(129) }
    ]) assert.equal((await request('POST', '/auth/login', undefined, payload)).statusCode, 400);
    assert.equal((await request('GET', '/team/invalid-id', a.accessToken)).statusCode, 400);
    assert.equal((await request('PATCH', `/team/${manager.user.id}`, a.accessToken, {})).statusCode, 400);
    assert.equal((await request('PATCH', `/team/${manager.user.id}`, a.accessToken, { isActive: 'false' })).statusCode, 400);
    assert.equal((await request('GET', '/audit-logs?limit=101', a.accessToken)).statusCode, 400);
    const malformed = await api.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{bad json' });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: 'INVALID_REQUEST' });
    const unsupported = await api.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/xml' }, payload: '<password/>' });
    assert.equal(unsupported.statusCode, 415);
    const oversized = await request('POST', '/auth/login', undefined, { email: a.user.email, password: 'x'.repeat(17_000) });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json(), { error: 'PAYLOAD_TOO_LARGE' });
  });

  await t.test('authentication rate limits share a bucket, resist forged forwarding headers, and leave health available', async () => {
    const limited = await buildApp({ ...config, AUTH_RATE_LIMIT_MAX: 2 }, { logger: false });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await limited.inject({
          method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9',
          headers: { 'x-forwarded-for': `192.0.2.${attempt}` }, payload: {}
        });
        assert.equal(response.statusCode, 400);
      }
      for (const path of ['login', 'register']) {
        const response = await limited.inject({ method: 'POST', url: `/api/auth/${path}`, remoteAddress: '203.0.113.9', payload: {} });
        assert.equal(response.statusCode, 429);
        assert.deepEqual(response.json(), { error: 'RATE_LIMITED' });
        assert.ok(response.headers['retry-after']);
      }
      assert.equal((await limited.inject({ url: '/api/health', remoteAddress: '203.0.113.9' })).statusCode, 200);
    } finally { await limited.close(); }
  });

  await t.test('database foreign keys reject cross-tenant parent links for every existing child model', async () => {
    // Fixtures exercise schema constraints only; no property/booking workflows are exposed.
    const property = await db.property.create({ data: {
      tenantId: b.user.tenantId, name: 'B fixture', area: 'Lagos', maxGuests: 2, bedrooms: 1, baseNightlyPriceKobo: 10000
    } });
    const conversation = await db.conversation.create({ data: {
      tenantId: b.user.tenantId, channel: 'WEBSITE', externalId: 'test-only'
    } });
    const tenantId = a.user.tenantId;
    const rejectsForeignKey = async (operation: Promise<unknown>) => assert.rejects(operation, (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003');
    await rejectsForeignKey(db.priceRule.create({ data: { tenantId, propertyId: property.id, label: 'Denied', nightlyPriceKobo: 1 } }));
    await rejectsForeignKey(db.availabilityBlock.create({ data: {
      tenantId, propertyId: property.id, startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-02T00:00:00Z'), reason: 'Denied'
    } }));
    await rejectsForeignKey(db.booking.create({ data: {
      tenantId, propertyId: property.id, guestPhone: 'test-only', checkIn: new Date('2027-01-01T00:00:00Z'), checkOut: new Date('2027-01-02T00:00:00Z'), guestCount: 1, quoteTotalKobo: 1
    } }));
    await rejectsForeignKey(db.message.create({ data: { tenantId, conversationId: conversation.id, direction: 'IN', body: 'Denied' } }));
    await rejectsForeignKey(db.authSession.create({ data: {
      tenantId, userId: b.user.id, tokenHash: 'test-cross-tenant', expiresAt: new Date()
    } }));
    await rejectsForeignKey(db.auditLog.create({ data: {
      tenantId, actorId: b.user.id, actorType: 'USER', action: 'Denied', entityType: 'User', entityId: a.user.id
    } }));
    const block = await db.availabilityBlock.create({ data: {
      tenantId: b.user.tenantId, propertyId: property.id, startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-02T00:00:00Z'), reason: 'Valid fixture'
    } });
    await rejectsForeignKey(db.availabilityBlock.update({ where: { id: block.id }, data: { tenantId } }));
  });

  await t.test('database rejects noncanonical email even when bypassing the HTTP validator', async () => {
    await assert.rejects(db.user.update({ where: { id: a.user.id }, data: { email: 'OWNER-A@EXAMPLE.COM' } }));
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: a.user.id } })).email, a.user.email);
  });

  await t.test('readiness succeeds with migrated tables and fails for an unmigrated schema', async () => {
    const ready = await request('GET', '/ready');
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { ready: true, dependencies: { database: 'connected' } });
    const unmigratedUrl = new URL(databaseUrl);
    unmigratedUrl.searchParams.set('schema', `${schema}_absent`);
    const unmigrated = await buildApp({ ...config, DATABASE_URL: unmigratedUrl.toString() }, { logger: false });
    try {
      assert.equal((await unmigrated.inject('/api/health')).statusCode, 200);
      assert.equal((await unmigrated.inject('/api/ready')).statusCode, 503);
    } finally { await unmigrated.close(); }
  });
});
