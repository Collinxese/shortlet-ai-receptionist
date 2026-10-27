import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export const healthRoutes: FastifyPluginAsync<{ db: PrismaClient }> = async (app, { db }) => {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', service: 'shortlet-ai-receptionist' }));
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      // Check connectivity AND required schema, so a partially migrated DB is not ready.
      await db.$queryRaw`SELECT 1 FROM "Tenant" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "User" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "AuthSession" LIMIT 0`;
      await db.$queryRaw`SELECT "bathrooms", "weekendNightlyPriceKobo", "refundPolicy" FROM "Property" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "PropertyFee" LIMIT 0`;
      await db.$queryRaw`SELECT reference, "quoteSnapshot", "holdExtensionCount" FROM "Booking" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "BookingOperation" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "Payment" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "BankTransferSetting" LIMIT 0`;
      await db.$queryRaw`SELECT simulation, inquiry, "bookingId" FROM "Conversation" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "ConversationTurn" LIMIT 0`;
      await db.$queryRaw`SELECT 1 FROM "ConversationEscalation" LIMIT 0`;
      return { ready: true, dependencies: { database: 'connected' } };
    } catch {
      return reply.code(503).send({ ready: false, dependencies: { database: 'unavailable' } });
    }
  });
};
