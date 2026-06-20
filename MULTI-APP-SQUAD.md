# One Squad account, many apps (the webhook hub)

Squad allows **one webhook URL and one secret key per account**. The same is
true of Paystack and Monnify. When several apps share one Squad account
(vote, neflo, otuburu, …), they can't each register their own webhook — so one
app acts as a **hub** that receives every transaction, verifies it once, keeps
its own, and forwards the rest.

```
                Squad (one account · one webhook · one secret)
                                  │  POST  x-squad-encrypted-body
                                  ▼
              vote  /webhooks/squad-hub   ← the single dashboard webhook
                 1. verify HMAC-SHA512 once
                 2. settle vote's own payment locally (email+amount match)
                 3. if it wasn't vote's, forward the untouched body+signature →
                          ┌───────────────┬───────────────┐
                          ▼               ▼               ▼
                   neflo /webhooks   otuburu /webhooks   (future apps)
                     /squad             /squad
                 each re-verifies the SAME signature and settles its own
```

Forwarding carries the **original body and `x-squad-encrypted-body` header**
unchanged, so each downstream verifies the shared Squad secret exactly as if
Squad had called it directly. The signature is the authentication — no extra
shared secret is needed. Every app re-verifies with Squad before giving value,
so a mis-route can never double-credit.

## Why vote is the hub

Any always-on app on the account can host it; vote already holds the Squad
secret and is TypeScript, so it carries the hub. To move the hub to otuburu
later, replicate `/webhooks/squad-hub` there and re-point the dashboard webhook
— nothing else changes.

## Configure

On the **Squad dashboard** (Profile → API & Webhook):

```
Webhook URL:  https://vote.torama.money/webhooks/squad-hub
Redirect URL: https://vote.torama.money/account/pay/callback   (per-link redirect overrides this)
```

In the **hub app's `.env`** list the other apps (JSON):

```
SQUAD_DOWNSTREAMS=[
  {"name":"neflo",  "url":"https://neflo.pay/api/webhooks/squad",          "prefix":"nf_,cg_"},
  {"name":"otuburu","url":"https://otuburu.torama.money/payments/squad/webhook","prefix":"otu-"}
]
```

* `prefix` (optional) — reference prefixes the app owns. If the transaction
  reference starts with one, the hub forwards **only** to that app.
* No prefix match → the event is **broadcast** to every downstream; each app
  matches it against its own pending payments and ignores it otherwise
  (idempotent, so broadcasting is safe).

## What each downstream app needs

A webhook route that:

1. verifies `x-squad-encrypted-body` = uppercase-hex HMAC-SHA512 of the raw body
   with the shared `SQUAD_SECRET_KEY`, then
2. settles its own pending payment (the matcher is email + amount + a
   server-side `/transaction/verify`).

Status of each app:

| App | Downstream endpoint | State |
|-----|---------------------|-------|
| vote | `/webhooks/squad` | done — also self-settles its own |
| neflo | `/api/webhooks/squad` | done — already verifies `x-squad-encrypted-body` (no change) |
| otuburu | `/payments/squad/webhook` | route added (`wallet/internal/payments/squad.go`); verifies + acknowledges. Crediting is a TODO until otuburu has a Squad deposit flow |

Forwarding carries the original `x-squad-encrypted-body` header, so each app
re-verifies the shared secret with no extra config.

## Reference namespacing (recommended)

Give each app a distinct reference prefix so prefix-routing is exact and
broadcasts are rare:

| App | Reference / link-hash prefix |
|-----|------------------------------|
| vote | `vote-` |
| neflo | `nf_`, `cg_` |
| otuburu | `otu-` |

For inline checkouts (`/transaction/initiate`) the prefix is your own
`transaction_ref`, returned verbatim in the webhook. For payment-link payments
the transaction ref is Squad-generated, so those fall through to the
local-settle + broadcast path — still correct, just less targeted.
