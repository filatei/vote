# Shared-host app toolkit

Scripts to make "another app on the same Linode box, same IP, new subdomain of
`torama.money`" a **one-command** routine instead of a manual chore.

The model: every app gets its own `/opt/<app>` directory, its own Docker stack
(containers namespaced `<app>_*` on a private network), and a unique loopback
port. Apache on the host is the single front door — it terminates TLS
(Let's Encrypt) and reverse-proxies each subdomain to that app's port. Ports are
tracked in `/opt/.app-registry/ports.tsv` so they never collide.

```
                 Internet (one IP: 139.162.170.253)
                              │  :443
                       ┌──────┴───────┐
                       │   Apache     │  one vhost per subdomain
                       └──┬───┬───┬───┘
        127.0.0.1:8090 ───┘   │   └─── 127.0.0.1:8092 …
            vote_app      8091/blog_app    shop_app
        (vote_* stack)   (blog_* stack)  (shop_* stack)
```

## The key idea: wildcard DNS

Add **one** DNS record and you never touch DNS again:

```
*.torama.money   A   139.162.170.253
```

After that, any `something.torama.money` already resolves to the server, so
Let's Encrypt HTTP-01 validation just works and each new app is a single
`new-app.sh` call. (You can still add individual A records instead if you
prefer; the scripts work either way.)

## One-time setup

```bash
sudo bash infra/provision-host.sh
```

Installs Docker, Apache, certbot, enables the proxy/ssl/headers/rewrite modules,
creates the port registry, and **hardens SSH** (disables root login + password
auth, key-only). Idempotent.

The hardening is guarded against lockout: it will **not** disable password auth
unless the invoking admin already has a non-empty `~/.ssh/authorized_keys`. If
your key isn't set up for that user yet, it skips with instructions. To set the
key up and then harden:

```bash
# from your Mac, give user1 key login:
ssh-copy-id user1@vote.torama.money
# then on the server:
sudo bash infra/provision-host.sh --harden-only
```

Skip hardening entirely with `--no-harden`. To revert later:
`sudo rm /etc/ssh/sshd_config.d/00-hardening.conf && sudo systemctl reload ssh`.

> After hardening, keep your current SSH session open and confirm a **new**
> login works before closing it.

## Add an app — one command

```bash
# simplest: app name == subdomain, auto-assigned port, dedicated user
sudo bash infra/new-app.sh --name blog --email you@torama.money

# clone a repo and use a different subdomain
sudo bash infra/new-app.sh --name shop --subdomain store \
     --email you@torama.money --repo git@github.com:filatei/shop.git
```

This allocates a port, creates the `blog` user + `/opt/blog`, writes and enables
the Apache vhost for `blog.torama.money`, and installs the TLS cert with an
HTTP→HTTPS redirect. Then you just bring the app's containers up:

```bash
cd /opt/blog
# edit .env / docker-compose.yml so the app listens on the assigned port,
# bound to 127.0.0.1 (the script prints the port; it's also in ports.tsv)
docker compose up -d --build
```

Re-running `new-app.sh` for an existing app reuses its assigned port and just
refreshes the vhost — safe to run again.

## Where things live

| Path | What |
|------|------|
| `/opt/<app>` | the app's code + compose + `.env` |
| `/opt/.app-registry/ports.tsv` | app ↔ subdomain ↔ port registry |
| `/etc/apache2/sites-available/<sub>.torama.money.conf` | generated vhost |
| `/etc/letsencrypt/live/<sub>.torama.money/` | TLS cert (auto-renewed by certbot) |

## Conventions that keep apps isolated

- Namespace every container and network with the app name (`<app>_app`,
  `<app>_postgres`, `<app>_net`). The `vote` stack already follows this.
- Publish the app port **only on `127.0.0.1`** — never `0.0.0.0`. Databases and
  caches stay on the private network, unpublished.
- One deploy user per app (no sudo); host admin stays with `user1`.

## Removing an app

```bash
sudo a2dissite shop.store.torama.money.conf && sudo systemctl reload apache2
cd /opt/shop && docker compose down -v
sudo rm -rf /opt/shop
# then delete its row from /opt/.app-registry/ports.tsv
```

`vote` itself is just the first app onboarded this way — see the repo's
`docker-compose.yml`, `apache/`, and `DEPLOY.md`.
