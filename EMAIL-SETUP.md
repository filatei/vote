# Email setup (Google Workspace)

Torama Vote sends transactional email (magic-link sign-in, election URLs) via
SMTP using nodemailer. The recommended setup matches your other torama.money
apps: **Google Workspace SMTP relay**, authorised by the server's IP.

## Recommended: Google Workspace SMTP relay (no password)

Your Workspace already has an SMTP relay configured for this server
(`otuburu.torama.money` in Admin → Apps → Google Workspace → Gmail → Routing →
SMTP relay service). Because `vote.torama.money` runs on the **same server IP**,
it can relay through the same service with no credentials.

In `/opt/vote/.env`:

```ini
SMTP_HOST=smtp-relay.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
# no SMTP_USER / SMTP_PASS — the relay authorises this server by IP
MAIL_FROM=Torama Vote <no-reply@torama.money>
```

Make sure the relay entry covering this server's IP has:
- **Allowed senders:** "Only addresses in my domains" (or "Any address") — the
  `MAIL_FROM` must be an `@torama.money` address.
- **Authentication:** "Only accept mail from the specified IP addresses" with
  this server's IP (139.162.170.253) listed — that's what lets us skip a
  password. (If instead it requires SMTP auth, set `SMTP_USER`/`SMTP_PASS`.)

Then redeploy and test from the admin UI: **/admin/email → Verify connection**,
then send a test to yourself.

## Alternative: Gmail with an App Password

If you'd rather authenticate as a specific Workspace user:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@torama.money
SMTP_PASS=<16-char app password>   # Google Account → Security → App passwords
MAIL_FROM=Torama Vote <no-reply@torama.money>
```

(The OAuth Web client you created isn't needed for SMTP relay or app-password
sending. It would only be required for the Gmail API / XOAUTH2 path, which is
more involved.)

## Log mode (no email yet)

Leave `SMTP_HOST` blank and the app logs each email (including magic-links) to
the server logs instead of sending — handy for testing before the relay is
confirmed:

```bash
docker compose logs -f vote_app | grep -i email
```

## Verify

After setting `.env` and redeploying:

1. Sign in to `/admin`, open **Email settings**.
2. Click **Verify connection** — should report success for SMTP mode.
3. **Send a test** to your address and confirm it arrives.
