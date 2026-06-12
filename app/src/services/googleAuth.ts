import { config } from '../config';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function googleEnabled(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

/** Callback for the /admin Google sign-in flow. */
export function adminRedirectUri(): string {
  return config.GOOGLE_REDIRECT_URI || `${config.PUBLIC_BASE_URL}/admin/auth/google/callback`;
}

/** Callback for the customer (election creator) Google sign-in flow. */
export function accountRedirectUri(): string {
  return `${config.PUBLIC_BASE_URL}/account/auth/google/callback`;
}

/** The list of emails allowed into /admin (lower-cased). */
export function allowedAdminEmails(): string[] {
  return config.ADMIN_ALLOWED_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Build the Google consent URL to redirect to (redirectUri must match the flow). */
export function buildAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Exchange an authorization code for tokens and return the verified identity.
 * The id_token comes directly from Google's token endpoint over TLS using our
 * client secret, so it's trusted without a separate signature check (standard
 * authorization-code flow).
 */
export async function exchangeCode(code: string, redirectUri: string): Promise<GoogleIdentity | null> {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID ?? '',
      client_secret: config.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json = (await resp.json().catch(() => null)) as { id_token?: string } | null;
  if (!json?.id_token) return null;

  const parts = json.id_token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      email?: string;
      email_verified?: boolean | string;
      name?: string;
      aud?: string;
    };
    // Sanity-check the audience matches our client id.
    if (payload.aud && payload.aud !== config.GOOGLE_CLIENT_ID) return null;
    if (!payload.email) return null;
    return {
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: payload.name,
    };
  } catch {
    return null;
  }
}
