# Putting vote + otuburu behind Cloudflare (DNS proxy)

The apps stay on the Linode origin (Docker + Apache). Cloudflare sits in front
as CDN / TLS / WAF / DDoS. `torama.money` is already on Cloudflare nameservers,
so this is per-record configuration plus one origin change (real-IP restore).

## 1. Proxy the records

Cloudflare dashboard → DNS. For `vote` and `otuburu` (A/AAAA → the Linode IP),
switch the proxy status to **Proxied (orange cloud)**. Leave `MX` and any mail
records **DNS-only (grey)** so the Google SMTP relay / mail flow is untouched.

## 2. TLS mode = Full (strict)  ⚠ zone-wide

SSL/TLS → Overview → **Full (strict)**. This setting is **zone-wide** — it
applies to every proxied hostname at once (neflo, vote, otuburu). So only flip
to Full (strict) once **every proxied origin presents a valid cert**. neflo is
already proxied but its origin cert isn't sorted yet, so install the Origin CA
cert on neflo too (below) before switching, or neflo's TLS will fail under
strict. Until then, "Full" (non-strict) keeps everything up.

Also enable Edge Certificates → **Always Use HTTPS**, **Min TLS 1.2**.

## 3. Origin CA certificate (closes the renewal problem)

With the proxy on, certbot's HTTP-01 challenge on :80 is 301'd by Cloudflare and
`certbot renew` starts failing. Fix it for good with a **Cloudflare Origin CA
cert**: one `*.torama.money` + `torama.money` cert (validity up to 15 years, no
renewal) that Cloudflare trusts, installed on every origin. (You already have an
Origin cert — reuse it for all three apps.)

Per origin server (vote, otuburu, neflo), in order:

```bash
# 1. Place the Origin cert + key (same wildcard cert on each box)
sudo mkdir -p /etc/ssl/cloudflare
sudo install -m 644 origin.pem /etc/ssl/cloudflare/torama.money.pem
sudo install -m 600 origin.key /etc/ssl/cloudflare/torama.money.key

# 2. Point the vhost at them (swap the two SSLCertificate* lines — the Origin CA
#    alternatives are already in the repo vhosts, commented). Then GATE on:
sudo apache2ctl configtest        # must say "Syntax OK"
sudo systemctl reload apache2
```

Ordering that avoids any downtime:

1. **Proxy** the record (orange cloud) while the origin still has its valid
   Let's Encrypt cert — Full/strict accepts it, traffic flows through Cloudflare.
2. Place the Origin cert + key on the box.
3. Swap the vhost to the Origin CA lines → `configtest` → reload.
4. Once **all** proxied origins are on Origin CA, set the zone to **Full
   (strict)**. certbot can then be left to lapse (or removed).

> Origin CA certs are trusted **only by Cloudflare**, so a host must be proxied
> before you swap its cert — direct (DNS-only) HTTPS to it would show untrusted.
> That's why vote/otuburu get proxied first.

## 4. Real visitor IP (origin change — already in the repo)

Behind the proxy the TCP peer is a Cloudflare edge IP, so the app would see
that instead of the real visitor — which would break vote's one-vote-per-device
and rate limiting (both use `req.ip`). The Apache vhosts now use **mod_remoteip**
with `CF-Connecting-IP` and Cloudflare's trusted ranges
(`apache/vote.torama.money.conf`, otuburu `infra/apache/otuburu.torama.money.conf`).

On the server, once:

```bash
sudo a2enmod remoteip
sudo systemctl reload apache2
# verify the access log now shows real client IPs, not 104.x/172.64.x
```

Express `TRUST_PROXY=true` (one hop = Apache) stays correct, because Apache now
forwards the corrected client IP.

## 5. Things that keep working (verify after cut-over)

- **Squad webhook hub** `POST /webhooks/squad-hub` and the forwards to neflo /
  otuburu — Cloudflare never caches POST, so these pass through untouched.
- **otuburu WebSocket** `/ws` — Network → **WebSockets** is on by default on
  proxied zones; the tick feed works.
- **Caching** — Cloudflare's default only caches by static file extension, never
  HTML or POST, so dynamic routes are safe. Optionally add a Cache Rule to
  *Bypass cache* for `/account/*`, `/admin/*`, `/api/*`, `/webhooks/*`,
  `/payments/*`, and an Edge-cache rule for `/static/*` + asset extensions.

## 6. Optional — lock the origin to Cloudflare

So no one can hit the Linode IP directly (and bypass the WAF), allow 443 only
from Cloudflare's ranges:

```bash
# example with ufw; pull the live list from https://www.cloudflare.com/ips/
for cidr in $(curl -s https://www.cloudflare.com/ips-v4); do sudo ufw allow from "$cidr" to any port 443 proto tcp; done
sudo ufw deny 443/tcp   # after confirming Cloudflare ranges are allowed
```

Keep your SSH port open to yourself; don't lock yourself out.

## What this does NOT do

It does not move the apps onto Cloudflare compute. Workers/Pages are serverless
with no persistent containers or databases, so the Postgres/Redis/Rust-gRPC/
WebSocket stack can't run there without a full re-architecture. This setup keeps
the apps on Linode and puts Cloudflare's edge in front.
