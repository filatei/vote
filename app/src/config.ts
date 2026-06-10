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

  // ── Admin Google Sign-In (OIDC) ──────────────────────────────────────
  // When client id + secret are set, /admin is gated behind Google sign-in
  // restricted to ADMIN_ALLOWED_EMAILS. If unset, the password login is used
  // (fallback, so you're never locked out before configuring OAuth).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(), // default PUBLIC_BASE_URL/admin/auth/google/callback
  ADMIN_ALLOWED_EMAILS: z.string().default('filatei@gmail.com,filatei@torama.money'),

  // When true, admins may delete ANY election (testing). When false
  // (production default), only unopened 'draft' elections can be deleted — an
  // election that has been opened can only be closed, preserving its record.
  ALLOW_ELECTION_DELETE: bool(false),

  // Where uploaded contestant photos are stored (a persisted docker volume in
  // production). Served read-only at /uploads.
  UPLOAD_DIR: z.string().default('/app/uploads'),

  // ── Paystack (same keys/var names as the other torama.money apps) ─────
  // Leave the secret blank to disable payments (customers can't launch).
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  // Base URL Paystack returns to after checkout (defaults to PUBLIC_BASE_URL).
  PAYSTACK_CALLBACK_URL: z.string().optional(),
  // Flat fee to launch one election, in MAJOR units (naira / dollars).
  PAYMENT_CURRENCY: z.string().default('NGN'),
  PAYMENT_AMOUNT: z.coerce.number().positive().default(100000),

  // Optional landing-page explainer video (direct .mp4/.webm URL, ideally
  // self-hosted at /static/...). Empty shows an animated illustration instead.
  LANDING_VIDEO_URL: z.string().optional(),

  // ── Transactional email ──────────────────────────────────────────────
  // Defaults target Google Workspace SMTP relay (smtp-relay.gmail.com),
  // IP-authorised — same setup the other torama.money apps use. With no
  // SMTP_HOST set the app runs in "log" mode (emails printed to logs).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool(false), // true only for port 465
  SMTP_USER: z.string().optional(), // omit for IP-authorised relay
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Torama Vote <no-reply@torama.money>'),
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
