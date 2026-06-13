import { createHmac, timingSafeEqual } from 'crypto';
import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { sendMail } from '../mailer';
import { getBoolSetting } from './settings';

const LS_API = 'https://api.lemonsqueezy.com/v1';

/** Whether the Lemon Squeezy store is configured (keys present). */
export function lsConfigured(): boolean {
  return Boolean(
    config.LEMONSQUEEZY_API_KEY && config.LEMONSQUEEZY_STORE_ID && config.LEMONSQUEEZY_VARIANT_ID,
  );
}

/** The admin's runtime on/off toggle (defaults to the .env value). */
export function subscriptionsToggledOn(): boolean {
  return getBoolSetting('subscriptions_enabled', config.SUBSCRIPTIONS_ENABLED);
}

/** True only when the toggle is ON *and* the LS store is configured. */
export function subscriptionsEnabled(): boolean {
  return subscriptionsToggledOn() && lsConfigured();
}

export function subscriptionPriceLabel(): string {
  return config.SUBSCRIPTION_PRICE_LABEL;
}

export interface CustomerSubscription {
  status: string | null;
  subscriptionId: string | null;
  endsAt: Date | null;
  renewsAt: Date | null;
  portalUrl: string | null;
}

export async function getCustomerSubscription(customerId: number): Promise<CustomerSubscription> {
  const { rows } = await pool.query<{
    subscription_status: string | null;
    ls_subscription_id: string | null;
    subscription_ends_at: Date | null;
    subscription_renews_at: Date | null;
    customer_portal_url: string | null;
  }>(
    `SELECT subscription_status, ls_subscription_id, subscription_ends_at,
            subscription_renews_at, customer_portal_url
       FROM customers WHERE id = $1`,
    [customerId],
  );
  const r = rows[0];
  return {
    status: r?.subscription_status ?? null,
    subscriptionId: r?.ls_subscription_id ?? null,
    endsAt: r?.subscription_ends_at ?? null,
    renewsAt: r?.subscription_renews_at ?? null,
    portalUrl: r?.customer_portal_url ?? null,
  };
}

/** Current access: active/on-trial, or cancelled/past-due but still within the paid period. */
export function hasActiveSubscription(sub: CustomerSubscription): boolean {
  if (!sub.status) return false;
  if (sub.status === 'active' || sub.status === 'on_trial') return true;
  if ((sub.status === 'cancelled' || sub.status === 'past_due') && sub.endsAt) {
    return new Date(sub.endsAt).getTime() > Date.now();
  }
  return false;
}

/** Cancel a subscription in Lemon Squeezy (cancels at period end; access stays
 *  until then). Optimistically updates our row; the webhook reconciles too. */
export async function cancelSubscription(customerId: number, subscriptionId: string): Promise<boolean> {
  if (!config.LEMONSQUEEZY_API_KEY) return false;
  try {
    const resp = await fetch(`${LS_API}/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.LEMONSQUEEZY_API_KEY}`,
        Accept: 'application/vnd.api+json',
      },
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'Lemon Squeezy cancel failed');
      return false;
    }
    const json = (await resp.json().catch(() => null)) as
      | { data?: { attributes?: { status?: string; ends_at?: string | null; renews_at?: string | null } } }
      | null;
    const attrs = json?.data?.attributes;
    await pool.query(
      `UPDATE customers SET subscription_status = $2, subscription_ends_at = $3, subscription_renews_at = $4 WHERE id = $1`,
      [customerId, attrs?.status ?? 'cancelled', attrs?.ends_at ?? null, attrs?.renews_at ?? null],
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'Lemon Squeezy cancel request error');
    return false;
  }
}

/** Resume (un-cancel) a subscription before it expires. */
export async function resumeSubscription(customerId: number, subscriptionId: string): Promise<boolean> {
  if (!config.LEMONSQUEEZY_API_KEY) return false;
  const body = { data: { type: 'subscriptions', id: subscriptionId, attributes: { cancelled: false } } };
  try {
    const resp = await fetch(`${LS_API}/subscriptions/${subscriptionId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.LEMONSQUEEZY_API_KEY}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'Lemon Squeezy resume failed');
      return false;
    }
    const json = (await resp.json().catch(() => null)) as
      | { data?: { attributes?: { status?: string; ends_at?: string | null; renews_at?: string | null } } }
      | null;
    const attrs = json?.data?.attributes;
    await pool.query(
      `UPDATE customers SET subscription_status = $2, subscription_ends_at = $3, subscription_renews_at = $4 WHERE id = $1`,
      [customerId, attrs?.status ?? 'active', attrs?.ends_at ?? null, attrs?.renews_at ?? null],
    );
    return true;
  } catch (err) {
    logger.error({ err }, 'Lemon Squeezy resume request error');
    return false;
  }
}

/** Create a Lemon Squeezy hosted checkout for this customer; returns the URL to redirect to. */
export async function createCheckout(customer: { id: number; email: string }): Promise<string | null> {
  if (!subscriptionsEnabled()) return null;
  const body = {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: {
          email: customer.email,
          custom: { customer_id: String(customer.id) },
        },
        product_options: {
          redirect_url: `${config.PUBLIC_BASE_URL}/account/billing?sub=success`,
        },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(config.LEMONSQUEEZY_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(config.LEMONSQUEEZY_VARIANT_ID) } },
      },
    },
  };
  try {
    const resp = await fetch(`${LS_API}/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.LEMONSQUEEZY_API_KEY}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      logger.error({ status: resp.status }, 'Lemon Squeezy checkout creation failed');
      return null;
    }
    const json = (await resp.json().catch(() => null)) as
      | { data?: { attributes?: { url?: string } } }
      | null;
    return json?.data?.attributes?.url ?? null;
  } catch (err) {
    logger.error({ err }, 'Lemon Squeezy checkout request error');
    return null;
  }
}

/** Verify the LS `X-Signature` webhook header (HMAC-SHA256 of the raw body). */
export function verifyWebhookSignature(raw: Buffer, signature: string): boolean {
  const secret = config.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface LsWebhook {
  meta?: { event_name?: string; custom_data?: { customer_id?: string } };
  data?: {
    id?: string;
    attributes?: {
      status?: string;
      user_email?: string;
      customer_id?: number;
      renews_at?: string | null;
      ends_at?: string | null;
      urls?: { customer_portal?: string };
    };
  };
}

/** Apply a `subscription_*` webhook to the matching customer row. */
export async function applySubscriptionEvent(raw: Buffer): Promise<void> {
  const evt = JSON.parse(raw.toString('utf8')) as LsWebhook;
  const name = evt.meta?.event_name || '';
  if (!name.startsWith('subscription')) return; // ignore order_*, etc.
  const attrs = evt.data?.attributes || {};

  // Resolve our customer: prefer the custom id we passed at checkout, else email.
  let customerId: number | null = evt.meta?.custom_data?.customer_id
    ? Number(evt.meta.custom_data.customer_id)
    : null;
  if (!customerId && attrs.user_email) {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM customers WHERE email = $1`, [
      attrs.user_email.toLowerCase(),
    ]);
    customerId = rows[0]?.id ?? null;
  }
  if (!customerId) {
    logger.warn({ name }, 'Lemon Squeezy webhook: no matching customer');
    return;
  }

  await pool.query(
    `UPDATE customers
        SET subscription_status = $2,
            ls_subscription_id = $3,
            ls_customer_id = $4,
            subscription_renews_at = $5,
            subscription_ends_at = $6,
            customer_portal_url = COALESCE($7, customer_portal_url)
      WHERE id = $1`,
    [
      customerId,
      attrs.status ?? null,
      evt.data?.id ?? null,
      attrs.customer_id != null ? String(attrs.customer_id) : null,
      attrs.renews_at ?? null,
      attrs.ends_at ?? null,
      attrs.urls?.customer_portal ?? null,
    ],
  );
  logger.info({ customerId, status: attrs.status, event: name }, 'Lemon Squeezy subscription updated');

  // Branded confirmation email on first activation (LS also sends its own receipt).
  if (name === 'subscription_created') {
    await sendSubscriptionWelcome(customerId, attrs.user_email).catch((err) =>
      logger.error({ err }, 'subscription welcome email failed'),
    );
  }
}

async function sendSubscriptionWelcome(customerId: number, emailFromEvent?: string): Promise<void> {
  let to = emailFromEvent || null;
  if (!to) {
    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM customers WHERE id = $1`, [
      customerId,
    ]);
    to = rows[0]?.email ?? null;
  }
  if (!to) return;
  const dash = `${config.PUBLIC_BASE_URL}/account`;
  const billing = `${config.PUBLIC_BASE_URL}/account/billing`;
  await sendMail({
    to,
    subject: `Your ${config.APP_NAME} subscription is active`,
    text:
      `Thank you for subscribing to ${config.APP_NAME}.\n\n` +
      `Your subscription is now active — you can open your elections for voting.\n\n` +
      `Go to your dashboard: ${dash}\n` +
      `Manage or cancel any time from Billing: ${billing}\n\n` +
      `— ${config.APP_NAME}`,
    html:
      `<p>Thank you for subscribing to <strong>${config.APP_NAME}</strong>.</p>` +
      `<p>Your subscription is now active — you can open your elections for voting.</p>` +
      `<p><a href="${dash}">Go to your dashboard</a> &middot; ` +
      `<a href="${billing}">Manage or cancel any time</a></p>` +
      `<p>— ${config.APP_NAME}</p>`,
  });
}
