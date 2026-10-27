export type UserRole = 'OWNER' | 'MANAGER' | 'RECEPTIONIST';

export type Permission =
  | 'dashboard:read'
  | 'inbox:read'
  | 'inbox:reply'
  | 'inbox:takeover'
  | 'leads:read'
  | 'leads:update'
  | 'bookings:read'
  | 'bookings:create'
  | 'bookings:cancel'
  | 'properties:read'
  | 'properties:write'
  | 'pricing:write'
  | 'availability:write'
  | 'payments:read'
  | 'payments:create'
  | 'payments:verify'
  | 'payment-settings:write'
  | 'refunds:approve'
  | 'team:read'
  | 'team:write'
  | 'settings:write'
  | 'audit:read';

const permissions: Record<UserRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([
    'dashboard:read', 'inbox:read', 'inbox:reply', 'inbox:takeover',
    'leads:read', 'leads:update', 'bookings:read', 'bookings:create', 'bookings:cancel',
    'properties:read', 'properties:write', 'pricing:write', 'availability:write',
    'payments:read', 'payments:create', 'payments:verify', 'payment-settings:write', 'refunds:approve', 'team:read', 'team:write', 'settings:write', 'audit:read'
  ]),
  MANAGER: new Set<Permission>([
    'dashboard:read', 'inbox:read', 'inbox:reply', 'inbox:takeover',
    'leads:read', 'leads:update', 'bookings:read', 'bookings:create', 'bookings:cancel',
    'properties:read', 'properties:write', 'pricing:write', 'availability:write',
    'payments:read', 'payments:create', 'payments:verify', 'payment-settings:write', 'team:read', 'audit:read'
  ]),
  RECEPTIONIST: new Set<Permission>([
    'dashboard:read', 'inbox:read', 'inbox:reply', 'inbox:takeover',
    'leads:read', 'leads:update', 'bookings:read', 'bookings:create', 'bookings:cancel',
    'properties:read', 'payments:create', 'payments:read'
  ])
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissions[role].has(permission);
}

export function assertTenantAccess(authenticatedTenantId: string, resourceTenantId: string): void {
  if (!authenticatedTenantId || authenticatedTenantId !== resourceTenantId) {
    // Keep the external response generic so callers cannot use it to enumerate tenants.
    throw new Error('RESOURCE_NOT_FOUND');
  }
}
