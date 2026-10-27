import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

export async function isolatedDatabase(t: TestContext) {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL test database.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  const schema = `phase2_test_${randomBytes(8).toString('hex')}`;
  url.searchParams.set('schema', schema);
  const databaseUrl = url.toString();
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  t.after(async () => {
    try {
      // A generated identifier only. Never remove an environment-supplied schema.
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await db.$disconnect(); }
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const cli = (...args: string[]) => execFileSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', encoding: 'utf8'
  });
  const executeMigration = (name: string) => cli('db', 'execute', '--schema', 'prisma/schema.prisma', '--file', `prisma/migrations/${name}/migration.sql`);
  return { db, schema, databaseUrl, executeMigration, deploy: () => cli('migrate', 'deploy') };
}
