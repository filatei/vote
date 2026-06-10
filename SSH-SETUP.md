# SSH & deploy access setup

This connects your Mac to the production server **vote.torama.money**
(`139.162.170.253`) as a dedicated `vote` user, and gives that user a GitHub
deploy key for `filatei/vote`.

You log into the box today as **user1** (sudo). The `vote` user will reuse your
existing SSH key.

## One command (run on your Mac)

From the repo root:

```bash
bash scripts/setup-local-ssh.sh
```

That will:

1. Find your existing public key (`~/.ssh/id_ed25519.pub`, else `id_rsa.pub`).
   Pass a different one if you like: `bash scripts/setup-local-ssh.sh ~/.ssh/other.pub`
2. Add a `vote` host alias to `~/.ssh/config` (so you can just `ssh vote`).
3. Upload your key + `scripts/server-bootstrap.sh` to `user1@vote.torama.money`
   and run it with sudo. The bootstrap:
   - creates the `vote` user (key-only login),
   - installs your public key,
   - adds `vote` to the `docker` group,
   - prepares `/opt/vote` owned by `vote`,
   - generates a **GitHub deploy key** and prints it.

> If your subdomain differs or you use a different admin user:
> `SERVER=vote.torama.money ADMIN_USER=user1 bash scripts/setup-local-ssh.sh`

## Add the deploy key to GitHub

The bootstrap prints a public key at the end. Add it here:

- https://github.com/filatei/vote/settings/keys/new
- Title: `vote.torama.money` — tick *Allow write access* only if you'll push
  from the server (not needed for deploy-only pulls).

## Clone the repo on the server

```bash
ssh vote
git clone git@github.com:filatei/vote.git /opt/vote   # if not already cloned
cd /opt/vote
```

Then continue with **DEPLOY.md** (set `.env`, `docker compose up -d --build`,
create an admin, Apache vhost + certbot).

## Verify

```bash
ssh vote 'whoami && groups && ls -la /opt/vote'
# -> vote ; ...docker... ; repo contents
```

## Security notes

- The `vote` user has **no password** — key-based login only.
- It is **not** in `sudo`; it only manages Docker and `/opt/vote`. Use `user1`
  for host-level admin (apt, apache, certbot).
- Nothing here changes `sshd_config`. If you later want to disable password
  auth server-wide, do it deliberately as `user1` after confirming key login
  works for everyone who needs it.
