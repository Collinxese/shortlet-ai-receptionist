import { z } from 'zod';

export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const password = z.string().min(12).max(128);
export const name = z.string().trim().min(1).max(120);
export const id = z.string().regex(/^c[a-z0-9]{20,31}$/);
export const emptyQuery = z.strictObject({});

export const registrationBody = z.strictObject({
  tenantName: name,
  name,
  email,
  password
});

export const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(128)
});

// Ownership is created only by registration; team management cannot grant it.
const teamRole = z.enum(['MANAGER', 'RECEPTIONIST']);
export const createTeamBody = z.strictObject({ name, email, password, role: teamRole });
export const updateTeamBody = z.strictObject({
  role: teamRole.optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0);
export const userParams = z.strictObject({ userId: id });
export const updateTenantBody = z.strictObject({ name });
export const auditQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
