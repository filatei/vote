import { createHmac, timingSafeEqual } from 'crypto';
import express, { Router } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { reconcileSquadWebhook, verifyPayment } from '../services/payments';
import { getElectionById, setStatus } from '../services/elections';
import { parseWebhook, verifyWebhookSignature as verifySquadSignature } from '../services/squad';

export const webhookRouter = Router();

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
    const evt = parseWebhook(raw);
    if (evt && evt.status.includes('success')) {
      const electionId = await reconcileSquadWebhook({
        transactionRef: evt.transactionRef,
        email: evt.email,
        amountSubunits: evt.amountSubunits,
      });
      if (electionId) {
        const el = await getElectionById(electionId);
        if (el && el.status === 'draft') await setStatus(electionId, 'open');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Squad webhook handling failed');
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
