import { createHmac, timingSafeEqual } from 'crypto';
import express, { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { verifyPayment } from '../services/payments';
import { applySubscriptionEvent, verifyWebhookSignature } from '../services/subscriptions';

export const webhookRouter = Router();

/**
 * Lemon Squeezy subscription webhook. Signed with HMAC-SHA256 of the raw body
 * using the webhook signing secret, in the `X-Signature` header.
 */
webhookRouter.post('/lemonsqueezy', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = String(req.headers['x-signature'] || '');
  if (!verifyWebhookSignature(raw, signature)) {
    res.sendStatus(401);
    return;
  }
  try {
    await applySubscriptionEvent(raw);
  } catch (err) {
    logger.error({ err }, 'Lemon Squeezy webhook handling failed');
  }
  res.sendStatus(200);
});

/**
 * Paystack webhook. A Paystack account has ONE webhook URL (likely already
 * pointed at another torama.money app), so this is a belt-and-braces path — the
 * authoritative confirmation is the callback `verify`. Signature is HMAC-SHA512
 * of the raw body with the secret key.
 */
webhookRouter.post('/paystack', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = config.PAYSTACK_SECRET_KEY;
  if (!secret) {
    res.sendStatus(200);
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const expected = createHmac('sha512', secret).update(raw).digest('hex');
  const provided = String(req.headers['x-paystack-signature'] || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.sendStatus(401);
    return;
  }
  try {
    const evt = JSON.parse(raw.toString('utf8')) as { data?: { reference?: string } };
    const reference = evt?.data?.reference;
    if (reference) await verifyPayment(reference);
  } catch (err) {
    logger.error({ err }, 'Paystack webhook handling failed');
  }
  res.sendStatus(200);
});
