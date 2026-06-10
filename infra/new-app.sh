#!/usr/bin/env bash
# ============================================================================
# Add a new app on the shared host under a new subdomain of torama.money.
#
# In ONE command it:
#   * allocates a free loopback port (tracked in /opt/.app-registry/ports.tsv),
#   * creates a dedicated deploy user + /opt/<app> (unless --no-user),
#   * optionally clones a git repo into /opt/<app>,
#   * renders an Apache reverse-proxy vhost for <sub>.torama.money,
#   * obtains + installs a Let's Encrypt cert and the HTTP->HTTPS redirect,
#   * drops a starter docker-compose.yml if the app dir is empty.
#
# Usage (run as root):
#   sudo bash infra/new-app.sh --name blog --email you@torama.money
#   sudo bash infra/new-app.sh --name shop --subdomain store \
#        --email you@torama.money --repo git@github.com:filatei/shop.git
#
# Options:
#   --name NAME         app name; used for the user, /opt/NAME, container prefix
#   --subdomain SUB     subdomain label (default: NAME)  -> SUB.torama.money
#   --email EMAIL       email for Let's Encrypt (required unless --no-tls)
#   --port N            fixed loopback port (default: auto-allocated)
#   --repo URL          git repo to clone into /opt/NAME (optional)
#   --domain BASE       base domain (default: torama.money)
#   --user NAME         deploy user (default: NAME)
#   --no-user           don't create a user; /opt/NAME owned by current sudo user
#   --no-tls            skip certbot (HTTP only) — for testing
# ============================================================================
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

# ---- defaults + arg parsing ------------------------------------------------
NAME=""; SUBDOMAIN=""; EMAIL=""; PORT=""; REPO=""
DOMAIN="torama.money"; USER_NAME=""; MAKE_USER=1; DO_TLS=1
PORT_START=8090

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      NAME="$2"; shift 2;;
    --subdomain) SUBDOMAIN="$2"; shift 2;;
    --email)     EMAIL="$2"; shift 2;;
    --port)      PORT="$2"; shift 2;;
    --repo)      REPO="$2"; shift 2;;
    --domain)    DOMAIN="$2"; shift 2;;
    --user)      USER_NAME="$2"; shift 2;;
    --no-user)   MAKE_USER=0; shift;;
    --no-tls)    DO_TLS=0; shift;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

[[ -n "$NAME" ]] || { echo "ERROR: --name is required." >&2; exit 1; }
[[ "$NAME" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "ERROR: --name must be lowercase letters/digits/hyphens." >&2; exit 1; }
SUBDOMAIN="${SUBDOMAIN:-$NAME}"
USER_NAME="${USER_NAME:-$NAME}"
FQDN="${SUBDOMAIN}.${DOMAIN}"
APP_DIR="/opt/${NAME}"
REGISTRY_DIR="/opt/.app-registry"
PORTS_FILE="$REGISTRY_DIR/ports.tsv"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ $DO_TLS -eq 1 && -z "$EMAIL" ]]; then
  echo "ERROR: --email is required (or pass --no-tls for an HTTP-only test)." >&2
  exit 1
fi

install -d -m 755 "$REGISTRY_DIR"
[[ -f "$PORTS_FILE" ]] || printf "app\tsubdomain\tport\n" > "$PORTS_FILE"

# ---- allocate a port -------------------------------------------------------
existing_port="$(awk -F'\t' -v a="$NAME" '$1==a{print $3}' "$PORTS_FILE" | tail -1)"
if [[ -n "$PORT" ]]; then
  :
elif [[ -n "$existing_port" ]]; then
  PORT="$existing_port"   # reuse the port already assigned to this app
else
  # next free port above the highest registered (or PORT_START)
  maxp="$(awk -F'\t' 'NR>1 && $3 ~ /^[0-9]+$/ {print $3}' "$PORTS_FILE" | sort -n | tail -1)"
  PORT=$(( ${maxp:-$((PORT_START-1))} + 1 ))
  (( PORT < PORT_START )) && PORT=$PORT_START
fi

# record (replace any existing row for this app)
tmp="$(mktemp)"
awk -F'\t' -v a="$NAME" 'NR==1 || $1!=a' "$PORTS_FILE" > "$tmp"
printf "%s\t%s\t%s\n" "$NAME" "$SUBDOMAIN" "$PORT" >> "$tmp"
mv "$tmp" "$PORTS_FILE"
echo "==> $FQDN  ->  127.0.0.1:$PORT  (app: $NAME)"

# ---- deploy user + app dir -------------------------------------------------
if [[ $MAKE_USER -eq 1 ]]; then
  if ! id -u "$USER_NAME" >/dev/null 2>&1; then
    echo "==> Creating deploy user '$USER_NAME'"
    adduser --disabled-password --gecos "$NAME deploy" "$USER_NAME"
  fi
  getent group docker >/dev/null 2>&1 || groupadd docker
  usermod -aG docker "$USER_NAME"
  install -d -o "$USER_NAME" -g "$USER_NAME" "$APP_DIR"
  OWNER="$USER_NAME"
else
  install -d "$APP_DIR"
  OWNER="${SUDO_USER:-root}"
  chown "$OWNER":"$OWNER" "$APP_DIR" 2>/dev/null || true
fi

# ---- optional clone --------------------------------------------------------
if [[ -n "$REPO" ]]; then
  if [[ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    echo "==> Cloning $REPO into $APP_DIR"
    if [[ $MAKE_USER -eq 1 ]]; then
      sudo -u "$USER_NAME" -H git clone "$REPO" "$APP_DIR" \
        || echo "   (clone failed — add the deploy key to GitHub, then clone manually)"
    else
      git clone "$REPO" "$APP_DIR" || echo "   (clone failed — check access)"
    fi
  else
    echo "==> $APP_DIR not empty; skipping clone"
  fi
fi

# ---- starter compose if app dir is empty -----------------------------------
if [[ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
  echo "==> Writing starter docker-compose.yml into $APP_DIR"
  sed -e "s/__APP__/${NAME}/g" -e "s/__PORT__/${PORT}/g" \
    "$SCRIPT_DIR/templates/docker-compose.tpl.yml" > "$APP_DIR/docker-compose.yml"
  chown "$OWNER":"$OWNER" "$APP_DIR/docker-compose.yml" 2>/dev/null || true
fi

# ---- apache vhost ----------------------------------------------------------
VHOST="/etc/apache2/sites-available/${FQDN}.conf"
echo "==> Writing Apache vhost $VHOST"
sed -e "s/__FQDN__/${FQDN}/g" -e "s/__PORT__/${PORT}/g" -e "s/__APP__/${NAME}/g" \
  "$SCRIPT_DIR/templates/vhost.conf.tpl" > "$VHOST"
a2ensite "${FQDN}.conf" >/dev/null
apache2ctl configtest
systemctl reload apache2

# ---- TLS -------------------------------------------------------------------
if [[ $DO_TLS -eq 1 ]]; then
  echo "==> Obtaining Let's Encrypt certificate for $FQDN"
  certbot --apache -d "$FQDN" --non-interactive --agree-tos -m "$EMAIL" --redirect
fi

echo
echo "----------------------------------------------------------------------"
echo "Done: https://$FQDN  ->  127.0.0.1:$PORT"
echo
echo "Next:"
echo "  1) cd $APP_DIR  and configure the app (.env, docker-compose.yml)."
echo "  2) Make the app listen on port $PORT, bound to 127.0.0.1 (compose:"
echo "     ports: \"127.0.0.1:$PORT:$PORT\")."
echo "  3) docker compose up -d --build"
echo "----------------------------------------------------------------------"
