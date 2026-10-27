import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTenantAccess, hasPermission } from '../src/services/authorization.js';

test('owner can approve refunds and manage settings', () => {
  assert.equal(hasPermission('OWNER', 'refunds:approve'), true);
  assert.equal(hasPermission('OWNER', 'settings:write'), true);
});

test('receptionist cannot approve refunds or change sensitive settings', () => {
  assert.equal(hasPermission('RECEPTIONIST', 'refunds:approve'), false);
  assert.equal(hasPermission('RECEPTIONIST', 'settings:write'), false);
  assert.equal(hasPermission('RECEPTIONIST', 'inbox:reply'), true);
});

test('cross-tenant resource access is denied', () => {
  assert.doesNotThrow(() => assertTenantAccess('tenant-a', 'tenant-a'));
  assert.throws(() => assertTenantAccess('tenant-a', 'tenant-b'), /RESOURCE_NOT_FOUND/);
});
