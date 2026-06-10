# Continuous deployment setup

When CI passes on `main`, GitHub Actions SSHes into the server and runs
`infra/deploy.sh` (git pull + `docker compose up -d --build`). This is a
**one-time** setup. The security model:

- CI connects as `user1` using a **dedicated key** that is locked to a single
  forced command — it cannot open a shell or run anything else.
- A **scoped sudoers rule** lets that command run `infra/deploy.sh` as root and
  nothing more.
- `vote` stays a no-login app user; the deploy script pulls *as* vote (for the
  GitHub deploy key) but is orchestrated by root.

## 1. Generate a dedicated CD key (on your Mac)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vote_cd -N "" -C "vote-cd@github"
```

This makes `~/.ssh/vote_cd` (private) and `~/.ssh/vote_cd.pub` (public).

## 2. Add the private key as a GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `DEPLOY_SSH_KEY`
- Value: the full contents of `~/.ssh/vote_cd` (the private key, including the
  `-----BEGIN/END-----` lines)

```bash
pbcopy < ~/.ssh/vote_cd     # copies it; then paste into the secret
```

## 3. Authorize the key on the server, locked to the deploy command

Show the public key:

```bash
cat ~/.ssh/vote_cd.pub
```

Then on the server, append it to `user1`'s authorized_keys **with a forced
command** (replace `KEY...` with the line you just printed):

```bash
printf '%s %s\n' \
 'command="sudo /opt/vote/infra/deploy.sh",no-agent-forwarding,no-port-forwarding,no-x11-forwarding,no-pty' \
 'ssh-ed25519 AAAA...KEY... vote-cd@github' \
 >> ~/.ssh/authorized_keys
```

## 4. Allow that one command via sudo, without a password

```bash
echo 'user1 ALL=(root) NOPASSWD: /opt/vote/infra/deploy.sh' | sudo tee /etc/sudoers.d/vote-deploy
sudo chmod 440 /etc/sudoers.d/vote-deploy
sudo visudo -c        # should report: /etc/sudoers.d/vote-deploy: parsed OK
```

## 5. Make sure the script is present + executable

`deploy.sh` ships in the repo. Pull once so it exists before the first CD run:

```bash
sudo -u vote -H git -C /opt/vote pull --ff-only origin main
sudo chmod +x /opt/vote/infra/deploy.sh
```

## 6. Test it

```bash
# locally on the server first:
sudo /opt/vote/infra/deploy.sh

# then end-to-end: push a trivial commit to main and watch
#   https://github.com/filatei/vote/actions
```

After this, every green push to `main` redeploys automatically.

## Notes & hardening

- The forced command means a leaked CD key can only *trigger a deploy of code
  already on `main`* — it can't run arbitrary commands or read the box.
- Because `deploy.sh` lives in the repo and runs as root, anyone who can push to
  `main` can change what runs as root. That's inherent to repo-driven CD and is
  fine when you control the repo. To tighten further, copy the script to a
  **root-owned** path outside the repo (e.g. `/usr/local/sbin/vote-deploy`),
  point the forced command + sudoers there, and update it deliberately.
- Rollback: `cd /opt/vote && sudo -u vote -H git checkout <good-sha> && sudo docker compose up -d --build`.
- To pause CD, remove the `deploy` job's key (delete the `DEPLOY_SSH_KEY` secret)
  or the authorized_keys line.
