# Deploying Torama Vote on the shared Linode host

This walks through a production deploy to **vote.torama.money**, sharing the
Linode box with your other apps. The app, PostgreSQL and Redis run in their own
Docker containers (`vote_app`, `vote_postgres`, `vote_redis`) on a private
`vote_net` network. Apache on the host terminates TLS (Let's Encrypt) and
reverse-proxies to the app on `127.0.0.1:8090`.

> Coexistence: only `127.0.0.1:8090` is published to the host. If another app
> already uses 8090, pick a free port — change `APP_PORT` in `.env` and the
> `ProxyPass` line in the Apache vhost to match.

---

## 0. Prerequisites on the server

```bash
# Docker Engine + compose plugin
sudo apt update
sudo apt install -y docker.io docker-compose-plugin apache2 certbot python3-certbot-apache
sudo systemctl enable --now docker apache2

# Apache modules used by the vhost
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo systemctl reload apache2
```

Point DNS: an **A/AAAA record** for `vote.torama.money` → the Linode's IP.

---

## 1. Put the code at /opt/vote

```bash
sudo mkdir -p /opt/vote
sudo chown "$USER" /opt/vote
# copy this repository's contents into /opt/vote, e.g. via git or rsync
git clone <your-repo> /opt/vote      # or: rsync -a ./ /opt/vote/
cd /opt/vote
```

## 2. Configure secrets

```bash
cp .env.example .env
# generate strong secrets:
for k in SESSION_SECRET CSRF_SECRET CODE_PEPPER; do
  echo "$k=$(openssl rand -hex 32)"
done
# also set a strong POSTGRES_PASSWORD
nano .env
```

Back up `CODE_PEPPER` somewhere safe. If it's lost, all previously issued
voting codes become unredeemable.

## 3. Build and start the stack

```bash
cd /opt/vote
docker compose up -d --build
docker compose ps          # all three should be healthy
curl -s http://127.0.0.1:8090/healthz   # {"status":"ok"}
```

The schema in `db/init/01_schema.sql` loads automatically the first time the
Postgres volume is created.

## 4. Create the first admin

```bash
docker compose exec vote_app node dist/scripts/createAdmin.js admin you@torama.money
# prints a generated password once — save it
```

## 5. Apache vhost + HTTPS

```bash
sudo cp apache/vote.torama.money.conf /etc/apache2/sites-available/
sudo a2ensite vote.torama.money
sudo systemctl reload apache2

# Obtain + install the certificate (certbot edits the vhost in place):
sudo certbot --apache -d vote.torama.money
```

Certbot installs auto-renewal via a systemd timer. Verify:

```bash
sudo certbot renew --dry-run
```

Visit **https://vote.torama.money** — you should see the voter landing page,
and `https://vote.torama.money/admin/login` for the admin.

---

## Running an election (operator flow)

1. Sign in at `/admin/login`.
2. **New election** → title, ballot type (single / multiple), options, and when
   results become visible (live or after close).
3. Open the election (Status → **open**).
4. **Generate codes** for the number of voters. The codes are shown **once** —
   download the CSV and distribute each code to one voter out of band.
5. Voters go to the share link, enter their code, vote, and get a receipt.
6. Watch the live tally on the election page.
7. **Close** the election when done. Results and the bulletin board are public
   (or already were, if you chose live results). Anyone can recount from the
   board; each voter can confirm their receipt is listed.

---

## Operations

**Logs**
```bash
docker compose logs -f vote_app
```

**Update to a new version**
```bash
cd /opt/vote
git pull
docker compose up -d --build
```

**Backups** (do this regularly, and before closing important elections)
```bash
# database
docker compose exec -T vote_postgres \
  pg_dump -U voteuser votedb | gzip > /opt/vote/backups/votedb-$(date +%F).sql.gz
```
Add a cron entry for nightly dumps and copy them off-box.

**Restore**
```bash
gunzip -c backup.sql.gz | docker compose exec -T vote_postgres psql -U voteuser -d votedb
```

**Stop / start**
```bash
docker compose stop
docker compose start
```

---

## Security & fairness notes

- **Secret ballot.** `voting_codes` (hashed codes, used-flag) and `ballots`
  (anonymous choices + receipt) share no key, and both record only coarse dates,
  so no one — including admins with DB access — can link a voter to a ballot.
- **One vote per code** is enforced inside a `SERIALIZABLE` transaction with a
  row lock, so concurrent submits can't double-spend a code.
- **Codes** carry ~78 bits of entropy and are stored only as HMAC-SHA256 hashes
  with a server-side pepper; brute force is infeasible and rate-limited (20
  attempts / 10 min / IP).
- **Admin** sessions: bcrypt passwords, Redis-backed sessions, CSRF on every
  form, login rate-limited.
- **Transport**: HSTS + TLS via Apache; app sets a strict CSP (no inline JS),
  `X-Frame-Options: DENY`, no-referrer.
- **Private data stores**: Postgres/Redis are never published to the host.

### Hardening checklist
- [ ] Strong, unique `.env` secrets; `.env` not committed (it's gitignored).
- [ ] `CODE_PEPPER` backed up offline.
- [ ] Nightly DB backups copied off-box.
- [ ] Firewall: only 80/443 (+SSH) open on the Linode; app port stays on loopback.
- [ ] Host OS + Docker images patched regularly (`docker compose pull` for db/redis).
- [ ] For high-stakes votes, export the bulletin board after close as an
      independent record.

### Known trade-offs
- Codes are distributed by you; the system guarantees one-vote-per-code but not
  that each code reached the right person — handle distribution carefully.
- Receipts let voters verify inclusion but, by design, do not prove *to a third
  party* how someone voted (this is intentional, to resist vote-buying/coercion).
