import { z } from 'zod';

const environment = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:\/\//.test(value)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(30).default(10),
  AI_PROVIDER: z.enum(['mock','openai','disabled']).default('mock'),
  AI_MODEL: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/).optional()),
  OPENAI_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().regex(/^\S{10,512}$/).optional()),
  AI_TIMEOUT_MS: z.coerce.number().int().min(50).max(15000).default(5000),
  PAYSTACK_TEST_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  PAYSTACK_TEST_SECRET_KEY: z.preprocess((value) => value === '' ? undefined : value,
    z.string().regex(/^sk_test_[A-Za-z0-9]+$/).optional())
}).refine((value) => value.AI_PROVIDER !== 'openai' || Boolean(value.OPENAI_API_KEY && value.AI_MODEL), {
  path: ['AI_PROVIDER']
}).refine((value) => !value.PAYSTACK_TEST_ENABLED || Boolean(value.PAYSTACK_TEST_SECRET_KEY), {
  path: ['PAYSTACK_TEST_SECRET_KEY']
});

export type AppConfig = z.infer<typeof environment>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environment.safeParse(env);
  if (!result.success) {
    // Report variable names only: a malformed URL may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
