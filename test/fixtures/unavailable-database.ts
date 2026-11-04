import type { PrismaClient } from '@prisma/client';

const unavailableCall = new Proxy(function unavailableDatabaseCall() {}, {
  get(_target, property) {
    if (property === 'then') return undefined;
    return unavailableCall;
  },
  apply() {
    return Promise.reject(new Error('DATABASE_UNAVAILABLE'));
  }
});

/**
 * A Prisma-shaped offline dependency for negative-path tests.
 * Every database operation rejects without opening a socket.
 */
export function unavailableDatabase(): PrismaClient {
  return new Proxy({}, {
    get(_target, property) {
      if (property === '$disconnect') return async () => {};
      return unavailableCall;
    }
  }) as unknown as PrismaClient;
}
