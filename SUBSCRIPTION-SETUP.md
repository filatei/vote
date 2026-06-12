# Subscriptions (Lemon Squeezy) — setup

Torama Vote can require an active **monthly subscription** to *open* an election
for voting. Creating elections and adding candidates stays free — the subscription
is the "pay to launch" gate. Billing is handled by **Lemon Squeezy** (merchant of
record): they take the card payment in USD, handle tax, and give each customer a
hosted portal to update their card or cancel any time.

> Note: Lemon Squeezy charges cards in **USD**. Many Nigerian naira debit cards
> are blocked from international/USD payments under CBN rules, so customers paying
> from Nigeria may need a dollar/domiciliary card. (To accept naira on local
> cards you'd add a Nigerian processor such as Flutterwave — not covered here.)

## 1. Create the product in Lemon Squeezy

1. Sign up at https://lemonsqueezy.com and create your **Store**.
2. Create a **Subscription** product, e.g. "Torama Vote — Monthly", price **$8 /
   month**. Note its **Variant ID** (Products → your product → the variant).
3. Settings → **API** → create an **API key**. Copy it.
4. Note your **Store ID** (Settings → Stores, or the dashboard URL).

## 2. Configure the webhook

1. Settings → **Webhooks** → **+** Add endpoint.
2. Callback URL: `https://vote.torama.money/webhooks/lemonsqueezy`
3. Signing secret: enter any strong random string and copy it.
4. Subscribe to the **subscription** events:
   `subscription_created`, `subscription_updated`, `subscription_cancelled`,
   `subscription_resumed`, `subscription_expired`, `subscription_paused`,
   `subscription_unpaused`, `subscription_payment_failed`,
   `subscription_payment_success`.

## 3. Set environment variables on the server

In `/opt/vote/.env`:

```
SUBSCRIPTIONS_ENABLED=true
LEMONSQUEEZY_API_KEY=eyJ0eXAi...        # your API key
LEMONSQUEEZY_STORE_ID=12345
LEMONSQUEEZY_VARIANT_ID=67890           # the $8/month variant
LEMONSQUEEZY_WEBHOOK_SECRET=...          # the signing secret from step 2
SUBSCRIPTION_PRICE_LABEL=$8 / month
```

Then apply: `cd /opt/vote && sudo docker compose up -d --force-recreate vote_app`.

## 4. How it works

- A signed-in customer creates an election for free. When they try to **open** it
  (or visit **Billing**), they're prompted to subscribe.
- **Subscribe** sends them to a Lemon Squeezy hosted checkout. On success they're
  returned to `/account/billing`.
- Lemon Squeezy calls the webhook, which records the subscription status, renewal
  date, and the **customer portal URL** against the customer.
- With an active subscription they can open elections. From **Billing → Manage /
  cancel** they reach the Lemon Squeezy portal to change card or cancel; cancelling
  keeps access until the period ends, after which opening is blocked again.

## 5. Toggle off

Set `SUBSCRIPTIONS_ENABLED=false` (or leave the LS keys unset) and opening
elections is free again — nothing else changes.
