# Per-app ingress off Apache (Cloudflare → Caddy, one port each)

All torama.money apps share one Linode host. Instead of the shared Apache
terminating TLS for every app, each app gets its **own Caddy ingress** on its
own port, fronted by Cloudflare. An app can't be blocked by — or block — the
others, and there's no shared certbot to renew.

This mirrors what neflo already does. neflo is live on 8443; this doc adds
vote, daybook, and otuburu.

```
Browser ──TLS──> Cloudflare edge (TLS, WAF, rate limit, DDoS)
                    │  Origin Rule: <host> → origin port <NNNN>
                    ▼
            Linode :<NNNN> ──> <app>-caddy (Origin cert) ──> app container(s)
```

## Port map (Cloudflare proxy-compatible HTTPS ports only)

Cloudflare's proxy only connects to the origin on these HTTPS ports:
**443, 2053, 2083, 2087, 2096, 8443** — so the port must come from this set
(6443/7443/9443 would not work).

| App | Origin port | Caddy → app |
|-----|-------------|-------------|
| neflo | 8443 (done) | `app:3000` |
| vote | 2053 | `vote_app:8090` |
| daybook | 2083 | `daybook:8090` (incl. `/ws`) |
| otuburu | 2087 | path-routed: gateway 8082 / wallet 8083 / staking 8084 + static frontend |
| _spare_ | 2096 | — |

The Caddy sidecars are already in each repo (`infra/caddy/Caddyfile` +
a `caddy` service in the compose).

## Per-app bring-up (additive — Apache keeps serving until the last step)

Do this once per app (vote, daybook, otuburu). `<app>` = vote | daybook | otuburu,
`<port>` = 2053 | 2083 | 2087.

**1. Install the Cloudflare Origin cert** where the compose mounts it (reuse the
same `*.torama.money` origin cert on each — the host is shared, but each compose
mounts its own path):

```bash
sudo mkdir -p /opt/<app>/origin
sudo tee /opt/<app>/origin/cert.pem >/dev/null   # paste cert,  Ctrl-D
sudo tee /opt/<app>/origin/key.pem  >/dev/null   # paste key,   Ctrl-D
sudo chmod 600 /opt/<app>/origin/key.pem
```

**2. Open the port to Cloudflare only** (don't expose it to the world):

```bash
for r in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from "$r" to any port <port> proto tcp; done
```

**3. Deploy** (brings up the `caddy` container) and check the origin locally:

```bash
cd /opt/<app>/app   # or the app's compose dir
docker compose ... up -d            # use the app's usual compose command
docker compose ps                   # the caddy container should be Up
curl -k -H "Host: <app>.torama.money" https://127.0.0.1:<port>/ -I
```

**4. Cloudflare Origin Rule** — Rules → Origin Rules: _When_ `http.host` equals
`<app>.torama.money`, _set_ **Origin port = <port>**. (DNS record already
proxied; SSL/TLS mode Full (strict) is fine — Caddy serves the Origin cert.)

Or script all of them at once (idempotent, dry-run by default):

```bash
export CF_API_TOKEN=...     # Zone: Config Rules: Edit + Zone: Read
bash scripts/cloudflare-origin-ports.sh            # preview
CONFIRM=1 bash scripts/cloudflare-origin-ports.sh  # apply
```

**5. Verify end-to-end, then cut over** (stop Apache serving the app):

```bash
curl -I https://<app>.torama.money/        # served via Cloudflare → Caddy
# vote:    sudo a2dissite vote.torama.money            ; sudo systemctl reload apache2
# daybook: sudo a2dissite daybook                      ; sudo systemctl reload apache2
# otuburu: sudo a2dissite otuburu.torama.money         ; sudo systemctl reload apache2
# (run `ls /etc/apache2/sites-enabled` to confirm the exact site names)
```

After cut-over the app is fully off Apache. The Apache `mod_remoteip`/Origin-CA
work in CLOUDFLARE.md is then only relevant to any apps still on Apache.

## Notes per app

- **vote** — single service; Caddy → `vote_app:8090`. Caddy's `trusted_proxies`
  restores the real client IP, so one-vote-per-device + rate limiting keep
  working (Express `TRUST_PROXY=true` trusts the Caddy hop).
- **daybook** — single Node service serving PWA + API + `/ws`; Caddy upgrades
  WebSockets automatically. 30 MB upload cap matched.
- **otuburu** — Caddy replicates the Apache path map (gateway/wallet/staking)
  and serves the static frontend from `/opt/otuburu/frontend` (mounted into the
  caddy container). **Validate before cut-over** (live trading): after `up -d`,
  exercise `/api/*`, `/wallet/*`, `/payments/*`, `/staking`, the `/ws` tick feed,
  and the frontend over `https://127.0.0.1:2087` with the Host header.

## Rollback

Re-enable the Apache site and remove the Origin Rule for that host:
`sudo a2ensite <site> && sudo systemctl reload apache2`, then delete the
`torama-ingress:<host>` origin rule (or re-run the script after removing the
host from its MAP). DNS stays proxied throughout.
