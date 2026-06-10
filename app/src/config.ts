// Centralised, validated environment configuration.
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  APP_PORT: z.coerce.number().int().positive().default(8090),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8090'),
  TRUST_PROXY: bool(false),

  POSTGRES_DB: z.string().default('votedb'),
  POSTGRES_USER: z.string().default('voteuser'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_HOST: z.string().default('vote_postgres'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),

  REDIS_HOST: z.string().default('vote_redis'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  SESSION_SECRET: z.string().min(16),
  CSRF_SECRET: z.string().min(16),
  CODE_PEPPER: z.string().min(16),

  // When true, admins may delete ANY election (testing). When false
  // (production default), only unopened 'draft' elections can be deleted — an
  // election that has been opened can only be closed, preserving its record.
  ALLOW_ELECTION_DELETE: bool(false),

  // Where uploaded contestant photos are stored (a persisted docker volume in
  // production). Served read-only at /uploads.
  UPLOAD_DIR: z.string().default('/app/uploads'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message rather than booting half-configured.
  // eslint-disable-next-line no-console
  console.error(
    'Invalid environment configuration:\n' +
      parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'),
  );
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
};

export type Config = typeof config;
