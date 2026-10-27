import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/services/passwords.js';
import { hashSessionToken } from '../src/services/authentication.js';
import { registrationBody, updateTeamBody } from '../src/services/validation.js';

test('passwords use salted Argon2id and verify only the correct password', async () => {
  const password = 'a long test password 🔒';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^\$argon2id\$v=19\$/);
  assert.deepEqual(new Set(first.split('$')[3]?.split(',')), new Set(['m=65536', 't=3', 'p=1']));
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(first, password), true);
  assert.equal(await verifyPassword(first, 'incorrect password'), false);
});

test('session tokens are represented by a one-way digest in storage', () => {
  assert.equal(hashSessionToken('token').length, 64);
  assert.notEqual(hashSessionToken('token'), hashSessionToken('other token'));
});

test('registration normalizes email and rejects tenant or role injection and weak passwords', () => {
  const input = { tenantName: ' Lagos Lets ', name: ' Owner ', email: ' OWNER@EXAMPLE.COM ', password: 'long-password-1234' };
  assert.equal(registrationBody.parse(input).email, 'owner@example.com');
  for (const payload of [
    { ...input, tenantId: 'some-other-tenant' }, { ...input, role: 'MANAGER' },
    { ...input, password: 'short' }, { ...input, password: 'x'.repeat(129) },
    { ...input, email: 'invalid' }, { ...input, tenantName: ' ' }
  ]) assert.equal(registrationBody.safeParse(payload).success, false);
  assert.equal(updateTeamBody.safeParse({}).success, false);
  assert.equal(updateTeamBody.safeParse({ role: 'OWNER' }).success, false);
  assert.equal(updateTeamBody.safeParse({ isActive: 'false' }).success, false);
});
