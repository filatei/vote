# Torama Vote

A fast, reliable, web-based platform for groups to run **free and fair online elections**.

Live target: **https://vote.torama.money**

Torama Vote is built around a **secret-ballot + verifiable receipt** model using
**pre-issued anonymous voting codes**. A voter never logs in with a personal
identity; they redeem a single-use code that is decoupled from the ballot they
cast, so no one — not even an administrator — can link a person to their vote.
After voting, each voter receives a random **receipt code** they can use to
confirm their ballot was recorded and counted on a public bulletin board.

---

## Highlights

- **Secret ballot.** Voting codes and ballots live in separate tables with no
  foreign key or timestamp link. Codes are stored only as salted hashes.
- **One vote per code.** Redeeming a code flips an irreversible `used` flag
  inside a serialized transaction, preventing double-voting and races.
- **Verifiable.** Every ballot gets a public receipt. Voters verify their own
  vote; anyone can audit the full tally against the published bulletin board.
- **Ballot types.** Single-choice (pick one) and multiple-choice / approval
  (pick up to N) are supported per election.
- **Cross-browser.** Server-rendered HTML with progressive enhancement — core
  voting works even with JavaScript disabled, on any modern or legacy browser.
- **Containerised.** App, PostgreSQL and Redis each run in their own Docker
  container on an isolated network, namespaced so they coexist with other apps
  on the shared Linode host.
- **HTTPS by default.** Apache reverse-proxy terminates TLS via Let's Encrypt.

---

## Architecture

```
Browser ──HTTPS──> Apache (vhost: vote.torama.money, Let's Encrypt TLS)
                      │  reverse proxy → 127.0.0.1:8090
                      ▼
            ┌──────────────────────┐
            │  vote_app (Node/TS)  │  Express + EJS, port 8090
            └──────────┬───────────┘
                       │ internal docker network: vote_net
        ┌──────────────┴──────────────┐
        ▼                             ▼
┌────────────────┐          ┌──────────────────┐
│ vote_postgres  │          │   vote_redis     │
│  (PostgreSQL)  │          │ sessions + rate  │
│   port 5432*   │          │   limiting       │
└────────────────┘          └──────────────────┘
        * not published to host; only on vote_net
```

### Tech stack (chosen for speed + reliability + longevity)

| Layer        | Choice                          | Why |
|--------------|---------------------------------|-----|
| Runtime      | Node.js 20 LTS + TypeScript     | Fast, ubiquitous, type-safe |
| Web framework| Express 4 + EJS templates       | Mature, server-rendered, works in every browser |
| Database     | PostgreSQL 16                   | ACID, serializable transactions for vote integrity |
| Cache/session| Redis 7                         | Session store + distributed rate limiting |
| Security     | Helmet, bcrypt, CSRF, rate-limit| Defense in depth |
| Proxy/TLS    | Apache + Let's Encrypt          | Shared host, automatic HTTPS |

---

## Repository layout

```
/opt/vote
├── docker-compose.yml          # app + postgres + redis, namespaced for shared host
├── .env.example                # copy to .env and fill secrets
├── apache/
│   └── vote.torama.money.conf  # reverse-proxy vhost (HTTP→HTTPS, proxy to :8090)
├── db/
│   └── init/01_schema.sql       # schema, auto-loaded on first DB boot
├── app/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts            # app entry
│       ├── config.ts            # env config
│       ├── db.ts                # pg pool
│       ├── redis.ts
│       ├── logger.ts
│       ├── middleware/          # auth, csrf, rate-limit, errors
│       ├── routes/              # public, auth, admin
│       ├── services/            # elections, codes, ballots, tally
│       ├── util/                # crypto, validation
│       ├── views/               # EJS templates
│       └── public/              # css + progressive-enhancement js
├── DEPLOY.md                   # full server runbook
└── README.md
```

---

## Quick start (local)

```bash
cp .env.example .env        # then edit secrets
docker compose up --build   # builds app, starts postgres + redis
# open http://localhost:8090
```

Create the first admin once the stack is up:

```bash
docker compose exec vote_app node dist/scripts/createAdmin.js admin you@example.com
# prints a generated password (or set one with a 3rd arg)
```

For production deployment on the Linode host, see **[DEPLOY.md](DEPLOY.md)**.

---

## Security model — in plain terms

1. **Admin** creates an election with options and a ballot type, then generates
   a batch of voting codes. Codes are shown/exported **once**; only their hashes
   are stored.
2. Codes are distributed **out of band** (printed slips, sealed email, in person).
3. A **voter** opens the site, enters their code, and casts a ballot.
4. On submit, inside one serializable transaction the system:
   - verifies the code is valid and unused, then marks it **used** (no vote stored on the code row);
   - inserts an **anonymous ballot** (the choice(s) + a fresh random receipt), with no link back to the code.
5. The voter gets a **receipt code** and can verify it on the public bulletin board.
6. Results are tallied directly from anonymous ballots. Anyone can recount.

What this protects against: double voting, ballot-to-voter linkage, silent
tampering (receipts make dropped/altered ballots detectable), and brute-forcing
codes (high entropy + rate limiting).

See [DEPLOY.md](DEPLOY.md) for hardening notes and operational guidance.
