# Putting vote + otuburu behind Cloudflare (DNS proxy)

The apps stay on the Linode origin (Docker + Apache). Cloudflare sits in front
as CDN / TLS / WAF / DDoS. `torama.money` is already on Cloudflare nameservers,
so this is per-record configuration plus one origin change (real-IP restore).

## 1. Proxy the records

Cloudflare dashboard → DNS. For `vote` and `otuburu` (A/AAAA → the Linode IP),
switch the proxy status to **Proxied (orange cloud)**. Leave `MX` and any mail
records **DNS-only (grey)** so the Google SMTP relay / mail flow is untouched.

## 2. TLS mode = Full (strict)

SSL/TLS → Overview → **Full (strict)**. The origin already serves a valid
Let's Encrypt cert via Apache, so end-to-end TLS stays intact. Also enable:
Edge Certificates → **Always Use HTTPS**, **Min TLS 1.2**. (Origin already
sends HSTS.)

## 3. Cert renewal gotcha (important)

With the proxy **on** + *Always Use HTTPS*, certbot's HTTP-01 challenge on
port 80 is 301'd by Cloudflare before it reaches the origin, so
`certbot renew` will start failing. Pick one fix:

- **Recommended — Cloudflare Origin CA cert** (15-year, no renewal): SSL/TLS →
  Origin Server → Create Certificate, install the cert/key in each Apache vhost
  in place of the Let's Encrypt paths. Keep TLS mode Full (strict).
- *or* switch certbot to **DNS-01** with the Cloudflare API token, which works
  fine through the proxy.
- *or* add a Configuration Rule that disables "Always Use HTTPS" for
  `/.well-known/acme-challenge/*` (keeps Let's Encrypt HTTP-01 working).

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
