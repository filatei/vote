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

  // ── Branding ─────────────────────────────────────────────────────────
  // Single source of truth for the product name shown across the UI, emails,
  // certificates and meta tags. Defaults to "Verita"; per-tenant white-label
  // can override it later without touching templates.
  APP_NAME: z.string().default('Verita'),
  // Legal entity shown in the footer / certificates.
  APP_LEGAL_NAME: z.string().default('TORAMA Global Services Limited'),
  // One-line product tagline used in the footer and link previews.
  APP_TAGLINE: z.string().default('secret ballot with verifiable receipts'),

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

  // Platform-admin-only device forensic audit. When true, open/hybrid (per-
  // device) votes also record the client IP + user-agent in device_votes (still
  // unlinked from the ballot). OFF by default for privacy. See admin/devices.
  DEVICE_AUDIT_ENABLED: bool(false),

  // ── Payments ──────────────────────────────────────────────────────────
  // Master switch for the pay-before-launch paywall. OFF by default so
  // elections can be created and opened for free; set true (with a configured
  // provider) to require payment before an owner can open their election.
  PAYMENTS_ENABLED: bool(false),
  // Currency the metered price is charged in (Squad supports NGN & USD).
  PAYMENT_CURRENCY: z.string().default('NGN'),
  // Preferred rail. "squad" is primary; Monnify is kept as a fallback that is
  // used automatically when the preferred provider isn't configured.
  PAYMENT_PROVIDER: z.enum(['squad', 'monnify']).default('squad'),

  // ── Squad (primary NGN rail — GTBank / HabariPay payment links) ────────
  // Each election launch creates a one-off hosted payment link for the exact
  // metered amount. Leave the secret blank to disable Squad (falls back to
  // Monnify if configured). Sandbox keys start sandbox_sk_…, live sk_….
  SQUAD_SECRET_KEY: z.string().optional(),
  // API host. Sandbox: https://sandbox-api-d.squadco.com  Live: https://api-d.squadco.com
  SQUAD_BASE_URL: z.string().default('https://sandbox-api-d.squadco.com'),
  // Hosted-checkout host the link hash is appended to. Sandbox:
  // https://sandbox-pay.squadco.com  Live: https://pay.squadco.com
  SQUAD_PAY_BASE_URL: z.string().default('https://sandbox-pay.squadco.com'),
  // Optional static product/payment link from the dashboard (e.g.
  // https://pay.squadco.com/toramavote) — used as a manual fallback only.
  SQUAD_PAYMENT_LINK: z.string().optional(),

  // ── Monnify (fallback NGN rail — instant virtual-account + card) ───────
  // Reuses the same sandbox integration proven on otuburu. Leave the secret
  // blank to disable the Monnify rail.
  MONNIFY_API_KEY: z.string().optional(),
  MONNIFY_SECRET_KEY: z.string().optional(),
  MONNIFY_CONTRACT_CODE: z.string().optional(),
  MONNIFY_WALLET_ACCOUNT: z.string().optional(), // disbursement source (future)
  MONNIFY_BASE_URL: z.string().default('https://sandbox.monnify.com'),
  // Base URL the gateway returns to after checkout (defaults PUBLIC_BASE_URL).
  PAYMENT_CALLBACK_URL: z.string().optional(),

  // ── Per-voter pricing ──────────────────────────────────────────────────
  // Optional JSON override of the rate card (see services/pricing.ts for the
  // built-in default brackets). Shape: { "NGN": [[max,rate],...], "USD": [...] }.
  PRICING_TABLE: z.string().optional(),

  // ── Lemon Squeezy monthly subscription ($8/mo, cancel anytime) ────────
  // When enabled, an active subscription is required to OPEN an election for
  // voting (creating/editing stays free). OFF until the LS store is configured.
  SUBSCRIPTIONS_ENABLED: bool(false),
  LEMONSQUEEZY_API_KEY: z.string().optional(),
  LEMONSQUEEZY_STORE_ID: z.string().optional(),
  LEMONSQUEEZY_VARIANT_ID: z.string().optional(), // the $8/month subscription variant
  LEMONSQUEEZY_WEBHOOK_SECRET: z.string().optional(),
  SUBSCRIPTION_PRICE_LABEL: z.string().default('$8 / month'),

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
  MAIL_FROM: z.string().default('Verita <no-reply@torama.money>'),
  // Hostname used in the SMTP EHLO/HELO greeting. Must be a real FQDN or the
  // relay may refuse it (Google: "421-4.7.0 Try again later (EHLO)").
  SMTP_EHLO_NAME: z.string().default('vote.torama.money'),

  // ── Rate limiting (per client IP) ────────────────────────────────────
  // Defaults are sized for normal use. Raise temporarily for a load test
  // from a single source IP (e.g. RATE_LIMIT_GENERAL=100000), then revert.
  RATE_LIMIT_GENERAL: z.coerce.number().int().positive().default(120), // per minute
  RATE_LIMIT_CODE: z.coerce.number().int().positive().default(20), // per 10 minutes
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
