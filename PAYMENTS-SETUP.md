# Payments & per-voter pricing (Verita)

Verita prices each election by its **organiser-declared registered (enrolled) voter
count**. The total count selects one bracket and every voter is billed at that flat
rate (money spec §6). The first 50 voters are free, so small elections launch with no
payment. Payment is taken **before launch** — an election can only be opened once paid
(or if it's in the free tier).

## Rate card (default)

| Registered voters | ₦ / voter | $ / voter |
|---|---|---|
| 1 – 50 | Free | Free |
| 51 – 500 | ₦120 | $0.25 |
| 501 – 2,500 | ₦90 | $0.18 |
| 2,501 – 10,000 | ₦55 | $0.12 |
| 10,001 – 50,000 | ₦35 | $0.08 |
| 50,000+ | ₦22 (volume) | $0.045 |

Override with the `PRICING_TABLE` env var (JSON) if needed — see `.env.example`.
Brackets live in `app/src/services/pricing.ts`; unit tests in `pricing.test.ts`
verify the spec's worked examples.

## Rails — Monnify primary, Paystack fallback

`PAYMENT_PROVIDER=monnify` (default) uses Monnify when its keys are present, and
falls back to Paystack automatically if Monnify isn't configured. Set
`PAYMENTS_ENABLED=true` to turn the paywall on.

### Monnify (sandbox creds proven on otuburu)

```
MONNIFY_API_KEY=MK_TEST_xxxxxxxx
MONNIFY_SECRET_KEY=xxxxxxxx
MONNIFY_CONTRACT_CODE=xxxxxxxxxx
MONNIFY_WALLET_ACCOUNT=xxxxxxxxxx
MONNIFY_BASE_URL=https://sandbox.monnify.com   # live: https://api.monnify.com
```

Flow (`app/src/services/monnify.ts`):
1. **Auth** — `POST /api/v1/auth/login` with HTTP Basic `apiKey:secretKey` → bearer
   token (cached in memory until ~1 min before expiry).
2. **Init** — `POST /api/v1/merchant/transactions/init-transaction`; amount is sent in
   **naira (major units)**, not kobo. Returns `checkoutUrl` + `transactionReference`.
   Our `paymentReference` is stored so the webhook can match it.
3. **Verify (authoritative)** — `GET /api/v2/transactions/{transactionReference}`;
   confirms `paymentStatus === "PAID"` and `amountPaid` ≥ the metered amount before the
   election is marked paid + opened. Used by both the redirect callback and the webhook.

### Webhook

Point Monnify's webhook at `https://<host>/webhooks/monnify`. It is verified with
HMAC-SHA512 of the raw body using `MONNIFY_SECRET_KEY` in the `monnify-signature`
header, then re-verified server-side. Paystack's existing `/webhooks/paystack` is
unchanged.

## Notes

- The `paystack_payments` table is now provider-agnostic (`provider`,
  `provider_reference`, `voters` columns added by the idempotent boot migration).
- Setting the wrong voter count: organisers edit the registered-voter count on the
  election edit page while the election is still a draft.
