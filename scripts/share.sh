#!/usr/bin/env bash
# Public demo link: production web build on :3002 + free Cloudflare quick tunnel.
# Needs scripts/dev.sh running in another terminal (API, agent, WhatsApp).
#   bash ~/EXORA/sona-ecosystem/scripts/share.sh
set -euo pipefail
SONA="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SONA/apps/web"
curl -fsS http://localhost:4001/health >/dev/null || { echo "API not running — start scripts/dev.sh first"; exit 1; }
command -v cloudflared >/dev/null || brew install cloudflared

export NEXT_DIST_DIR=.next-share NEXT_PUBLIC_API_URL=/papi NEXT_PUBLIC_HIDE_DEMO_LOGINS=1 NEXT_TELEMETRY_DISABLED=1
echo "building production web…"
npx next build >/dev/null
npx next start -p 3002 >"$SONA/.live/share-web.log" 2>&1 &
WEB=$!
trap 'kill $WEB 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 30); do curl -fsS http://localhost:3002 >/dev/null 2>&1 && break; sleep 1; done

PW="$(grep -E '^DEMO_PASSWORD=' "$SONA/.env" | cut -d= -f2-)"
echo
echo "Login for the investor:  owner@portfolio.local  /  ${PW:-password123}"
echo "The https://….trycloudflare.com link appears below. Ctrl+C closes it."
echo
cloudflared tunnel --no-autoupdate --url http://localhost:3002
