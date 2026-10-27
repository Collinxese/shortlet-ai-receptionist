import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { HttpError } from './errors.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { loginBody, registrationBody } from './validation.js';

// Explicit allowlist: passwordHash is never selected for API responses.
export const publicUserSelect = {
  id: true, tenantId: true, name: true, email: true, role: true, isActive: true
} satisfies Prisma.UserSelect;
export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
export type AuthContext = { user: PublicUser; sessionId: string };

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthenticationService {
  private readonly dummyHash: Promise<string>;

  constructor(private readonly db: PrismaClient, private readonly ttlHours: number) {
    // Unknown accounts still perform one expensive password verification.
    this.dummyHash = hashPassword(randomBytes(32).toString('hex'));
  }

  private async issueSession(tx: Prisma.TransactionClient, user: PublicUser) {
    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlHours * 60 * 60 * 1000);
    await tx.authSession.create({ data: {
      tenantId: user.tenantId, userId: user.id,
      tokenHash: hashSessionToken(accessToken), expiresAt
    } });
    return { accessToken, tokenType: 'Bearer', expiresAt, user };
  }

  async register(input: z.infer<typeof registrationBody>) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: input.tenantName } });
        const user = await tx.user.create({
          data: { tenantId: tenant.id, name: input.name, email: input.email, passwordHash, role: 'OWNER' },
          select: publicUserSelect
        });
        await tx.auditLog.create({ data: {
          tenantId: tenant.id, actorId: user.id, actorType: 'USER',
          action: 'operator.registered', entityType: 'User', entityId: user.id
        } });
        return { ...await this.issueSession(tx, user), tenant: { id: tenant.id, name: tenant.name } };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new HttpError(409, 'ACCOUNT_UNAVAILABLE');
      }
      throw error;
    }
  }

  async login(input: z.infer<typeof loginBody>) {
    // This lookup and token lookup below are the only cross-tenant auth lookups.
    // A supplied tenant ID never grants access; password/session proof is required.
    const user = await this.db.user.findUnique({
      where: { email: input.email }, select: { ...publicUserSelect, passwordHash: true }
    });
    const valid = await verifyPassword(user?.passwordHash ?? await this.dummyHash, input.password);
    if (!user || !valid || !user.isActive) throw new HttpError(401, 'INVALID_CREDENTIALS');
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return this.db.$transaction(async (tx) => {
      const session = await this.issueSession(tx, safeUser);
      await tx.auditLog.create({ data: {
        tenantId: user.tenantId, actorId: user.id, actorType: 'USER',
        action: 'operator.login', entityType: 'User', entityId: user.id
      } });
      return session;
    });
  }

  async authenticate(authorization: string | undefined): Promise<AuthContext> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
    if (!match?.[1]) throw new HttpError(401, 'UNAUTHORIZED');
    const session = await this.db.authSession.findUnique({
      where: { tokenHash: hashSessionToken(match[1]) },
      select: { id: true, tenantId: true, expiresAt: true, user: { select: publicUserSelect } }
    });
    if (!session || session.expiresAt.getTime() <= Date.now() || !session.user.isActive ||
        session.tenantId !== session.user.tenantId) {
      throw new HttpError(401, 'UNAUTHORIZED');
    }
    // Read current role/activity from the database on every request, never from client claims.
    return { user: session.user, sessionId: session.id };
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.authSession.deleteMany({ where: {
        id: auth.sessionId, tenantId: auth.user.tenantId, userId: auth.user.id
      } });
      await tx.auditLog.create({ data: {
        tenantId: auth.user.tenantId, actorId: auth.user.id, actorType: 'USER',
        action: 'operator.logout', entityType: 'User', entityId: auth.user.id
      } });
    });
  }
}
