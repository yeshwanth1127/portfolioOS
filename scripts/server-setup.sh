#!/usr/bin/env bash
# One-shot server setup for PortfolioOS + Qlix backend + nginx + Let's Encrypt.
# Run as root on the server:
#   bash /opt/exora/sona-ecosystem/scripts/server-setup.sh portfolio.exora.solutions you@example.com
#
# Expects:
#   /opt/exora/sona-ecosystem   ← this repo (git clone … sona-ecosystem)
#   /opt/exora/qlix-monorepo    ← copied from your Mac (rsync, see docs/DEPLOY.md)
# Safe to re-run: keeps existing .env, data volumes and certificates.
set -euo pipefail

DOMAIN="${1:?usage: server-setup.sh <domain> <email-for-letsencrypt>}"
EMAIL="${2:?usage: server-setup.sh <domain> <email-for-letsencrypt>}"
ROOT=/opt/exora
SONA="$ROOT/sona-ecosystem"
QLIX="$ROOT/qlix-monorepo"
WEB_PORT="${WEB_PORT:-3101}"        # PortfolioOS web, bound to 127.0.0.1 only
QLIX_API_PORT="${QLIX_API_PORT:-4100}"
QLIX_PG_PORT="${QLIX_PG_PORT:-5434}"
log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$SONA/docker-compose.yml" ]] || die "$SONA missing — git clone https://github.com/yeshwanth1127/portfolioos.git $SONA"
[[ -d "$QLIX/adk_new/adk_new/capabilities/shared/portfolio_os" ]] || die "$QLIX missing or without portfolio_os — rsync it from your Mac (docs/DEPLOY.md)"
[[ -f "$QLIX/backend-adk/.env" ]] || die "$QLIX/backend-adk/.env missing — include it in the rsync"

log "1/7 packages (docker, nginx, certbot)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl jq openssl uuid-runtime ca-certificates dnsutils >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null
if ! command -v nginx >/dev/null; then
  if ss -ltnp 2>/dev/null | grep -qE ':80 .*users' ; then
    die "something other than nginx already listens on :80 ($(ss -ltnp | grep ':80 ' | head -1)). Stop it or proxy $DOMAIN → 127.0.0.1:$WEB_PORT yourself."
  fi
  apt-get install -y -qq nginx >/dev/null
fi
apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
systemctl enable --now docker nginx >/dev/null

log "2/7 Qlix backend (Postgres :$QLIX_PG_PORT, API 127.0.0.1:$QLIX_API_PORT)"
cd "$QLIX"
export POSTGRES_HOST_PORT="$QLIX_PG_PORT" API_HOST_PORT="$QLIX_API_PORT"
QC=(docker compose -p qlix-monorepo --env-file backend-adk/.env)
"${QC[@]}" build backend
"${QC[@]}" up -d postgres redis
"${QC[@]}" --profile release run --rm migrate
"${QC[@]}" up -d backend
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$QLIX_API_PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 3; done
curl -fsS "http://127.0.0.1:$QLIX_API_PORT/api/v1/health" >/dev/null || die "Qlix backend not healthy — ${QC[*]} logs backend"
QLIX_NET="$(docker network ls --format '{{.Name}}' | grep -E '^qlix-monorepo_default$' || true)"
[[ -n "$QLIX_NET" ]] || die "Qlix docker network not found"

log "3/7 PortfolioOS .env"
cd "$SONA"
if [[ ! -f .env ]]; then
  cp .env.server.example .env
  set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
  set_env JWT_SECRET "$(openssl rand -hex 32)"
  set_env AGENT_RUNNER_SECRET "$(openssl rand -hex 32)"
  set_env WA_SERVICE_SECRET "$(openssl rand -hex 32)"
  set_env DEMO_PASSWORD "sona-$(openssl rand -hex 6)"
  set_env WA_CONNECTOR_ID "$(uuidgen)"
  set_env WHATSAPP_AUTH_ENCRYPTION_KEY "$(openssl rand -hex 32)"
  set_env WEB_PORT "$WEB_PORT"
  set_env QLIX_NETWORK "$QLIX_NET"
  set_env QLIX_BACKEND_URL "http://backend:4000"
  chmod 600 .env
fi

log "4/7 Qlix agent for PortfolioOS"
if ! grep -qE '^QLIX_AGENT_ID=.+' .env; then
  QLIX_AGENT_PASSWORD="$(openssl rand -hex 12)" bash scripts/create-qlix-agent.sh "http://127.0.0.1:$QLIX_API_PORT" "portfolio-$(openssl rand -hex 3)@exora.local" > /root/portfolio-qlix-agent.txt
  chmod 600 /root/portfolio-qlix-agent.txt
  AID=$(grep '^QLIX_AGENT_ID=' /root/portfolio-qlix-agent.txt | cut -d= -f2-)
  TOK=$(grep '^QLIX_RUNNER_TOKEN=' /root/portfolio-qlix-agent.txt | cut -d= -f2-)
  [[ -n "$AID" && "$AID" != null && -n "$TOK" && "$TOK" != null ]] || die "agent creation failed: $(cat /root/portfolio-qlix-agent.txt)"
  sed -i "s|^QLIX_AGENT_ID=.*|QLIX_AGENT_ID=$AID|; s|^QLIX_RUNNER_TOKEN=.*|QLIX_RUNNER_TOKEN=$TOK|" .env
fi

log "5/7 PortfolioOS containers (first build takes a few minutes)"
cd "$ROOT"
docker compose -p portfolio --project-directory "$SONA" -f "$SONA/docker-compose.yml" -f "$SONA/docker-compose.server.yml" up -d --build
for _ in $(seq 1 90); do curl -fsS "http://127.0.0.1:$WEB_PORT" >/dev/null 2>&1 && break; sleep 3; done
curl -fsS "http://127.0.0.1:$WEB_PORT" >/dev/null || die "PortfolioOS web not up — docker compose -p portfolio logs portfolio"

log "6/7 nginx site for $DOMAIN"
cat > "/etc/nginx/sites-available/$DOMAIN" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 180s;   # agent turns can take a while
    }
}
NGINX
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t && systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi

log "7/7 HTTPS certificate"
SERVER_IP="$(curl -fsS -4 https://api.ipify.org || hostname -I | awk '{print $1}')"
DNS_IP="$(dig +short A "$DOMAIN" | tail -1)"
if [[ "$DNS_IP" != "$SERVER_IP" ]]; then
  echo "DNS for $DOMAIN points to '${DNS_IP:-nothing}', this server is $SERVER_IP."
  echo "Add an A record $DOMAIN → $SERVER_IP, wait a few minutes, then run:"
  echo "  certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect --non-interactive"
  echo "Meanwhile the site is on http://$DOMAIN once DNS resolves."
else
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect --non-interactive
fi

PW="$(grep '^DEMO_PASSWORD=' "$SONA/.env" | cut -d= -f2-)"
cat <<DONE

==================================================================
 PortfolioOS is live → https://$DOMAIN
 Login: owner@portfolio.local / $PW   (same password for every demo user)
 WhatsApp: Settings → Generate QR → scan with the bot phone
 Logs:   docker compose -p portfolio logs -f portfolio
 Update: cd $SONA && git pull && bash scripts/server-setup.sh $DOMAIN $EMAIL
==================================================================
DONE
