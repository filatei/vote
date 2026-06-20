import { createHmac, timingSafeEqual } from 'crypto';
import express, { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { reconcileSquadWebhook, sendLaunchReceipt, verifyPayment } from '../services/payments';
import { getElectionById, setStatus } from '../services/elections';
import { parseWebhook, verifyWebhookSignature as verifySquadSignature } from '../services/squad';
import { downstreams, forward, resolveTargets } from '../services/squadHub';

export const webhookRouter = Router();

/** Settle a verified Squad event against this app's own pending payments.
 *  Opens the election + emails a receipt (once) on first confirmation.
 *  Returns true when the event matched and settled one of our payments. */
async function settleSquadLocally(raw: Buffer): Promise<boolean> {
  const evt = parseWebhook(raw);
  if (!evt || !evt.status.includes('success')) return false;
  const res = await reconcileSquadWebhook({
    transactionRef: evt.transactionRef,
    email: evt.email,
    amountSubunits: evt.amountSubunits,
  });
  if (!res) return false;
  const el = await getElectionById(res.electionId);
  if (el && el.status === 'draft') await setStatus(res.electionId, 'open');
  if (res.newlyConfirmed) {
    await sendLaunchReceipt(res.reference).catch((err) =>
      logger.error({ err, reference: res.reference }, 'Squad receipt email failed'),
    );
  }
  return true;
}

/**
 * Squad webhook (primary rail). Fired on a successful transaction. Signed with
 * the uppercase-hex HMAC-SHA512 of the RAW body in `x-squad-encrypted-body`.
 * The link-payment webhook carries Squad's transaction ref + payer email +
 * amount, so we match it to the pending election payment, attach the gateway
 * ref, then verify server-side (authoritative) before opening the election.
 */
webhookRouter.post('/squad', express.raw({ type: '*/*' }), async (req, res) => {
  if (!config.SQUAD_SECRET_KEY) {
    res.sendStatus(200);
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = String(req.headers['x-squad-encrypted-body'] || '');
  if (!verifySquadSignature(raw, signature)) {
    res.sendStatus(401);
    return;
  }
  try {
    await settleSquadLocally(raw);
  } catch (err) {
    logger.error({ err }, 'Squad webhook handling failed');
  }
  res.sendStatus(200);
});

/**
 * Squad webhook HUB. Squad allows only one webhook URL per account, so this app
 * receives every transaction for the shared account here, verifies the
 * signature once, settles its own payments locally, then forwards anything that
 * isn't ours to the other apps' /webhooks/squad (configured via
 * SQUAD_DOWNSTREAMS). Downstreams re-verify the same forwarded body+signature.
 */
webhookRouter.post('/squad-hub', express.raw({ type: '*/*' }), async (req, res) => {
  if (!config.SQUAD_SECRET_KEY) {
    res.sendStatus(200);
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = String(req.headers['x-squad-encrypted-body'] || '');
  if (!verifySquadSignature(raw, signature)) {
    res.sendStatus(401);
    return;
  }
  // Don't relay events we forwarded to ourselves (defensive loop guard).
  const forwarded = req.headers['x-forwarded-by'] === 'squad-hub';
  try {
    const settledLocally = await settleSquadLocally(raw);
    if (!forwarded) {
      const evt = parseWebhook(raw);
      const targets = resolveTargets(evt?.transactionRef || '', settledLocally, downstreams());
      await Promise.all(targets.map((t) => forward(t, raw, signature)));
    }
  } catch (err) {
    logger.error({ err }, 'Squad hub handling failed');
  }
  res.sendStatus(200);
});

/**
 * Monnify webhook (fallback rail). Signed with HMAC-SHA512 of the raw body using
 * the merchant secret key, in the `monnify-signature` header. The authoritative
 * confirmation is still a server-side status query (verifyPayment). We match on
 * our own paymentReference, which Monnify echoes back as eventData.paymentReference.
 */
webhookRouter.post('/monnify', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = config.MONNIFY_SECRET_KEY;
  if (!secret) {
    res.sendStatus(200);
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const expected = createHmac('sha512', secret).update(raw).digest('hex');
  const provided = String(req.headers['monnify-signature'] || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.sendStatus(401);
    return;
  }
  try {
    const evt = JSON.parse(raw.toString('utf8')) as {
      eventData?: { paymentReference?: string };
    };
    const reference = evt?.eventData?.paymentReference;
    if (reference) await verifyPayment(reference);
  } catch (err) {
    logger.error({ err }, 'Monnify webhook handling failed');
  }
  res.sendStatus(200);
});
