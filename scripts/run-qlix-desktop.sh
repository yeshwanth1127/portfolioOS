#!/usr/bin/env bash
# Start the Qlix containers, point the desktop app at them, and open Qlix.
# PortfolioOS must already be up (scripts/run-portfolio.sh) for the plugin window.
set -euo pipefail

EXORA="$(cd "$(dirname "$0")/../.." && pwd)"
QLIX="$EXORA/qlix-final"
DATA_DIR="${HOME}/Library/Application Support/solutions.exora.qlix.desktop"
SETTINGS="${DATA_DIR}/qlix.env"

cd "$QLIX"

if ! command -v docker >/dev/null 2>&1; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"
fi
docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }

set -a
# shellcheck disable=SC1091
source .env
set +a

API_URL="http://127.0.0.1:${API_HOST_PORT:-4010}"
WEB_URL="http://127.0.0.1:${FRONTEND_HOST_PORT:-3010}"
PORTFOLIO_URL="${PORTFOLIO_WEB_URL:-http://127.0.0.1:3001}"

docker compose up -d

mkdir -p "$DATA_DIR"
touch "$SETTINGS"
# Keep every other setting. Replace only the two addresses this script owns.
grep -v -E '^(QLIX_API_BASE_URL|PORTFOLIO_WEB_URL)=' "$SETTINGS" > "${SETTINGS}.tmp" || true
{
  cat "${SETTINGS}.tmp"
  echo "QLIX_API_BASE_URL=${API_URL}"
  echo "PORTFOLIO_WEB_URL=${PORTFOLIO_URL}"
} > "$SETTINGS"
rm -f "${SETTINGS}.tmp"

echo "Waiting for Qlix…"
for _ in $(seq 1 60); do
  if curl -fsS "${API_URL}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

osascript -e 'quit app "Qlix"' >/dev/null 2>&1 || true
sleep 1
open -a "Qlix"

echo
echo "Qlix desktop is opening."
echo "  App API   ${API_URL}"
echo "  Web       ${WEB_URL}"
echo "  Portfolio ${PORTFOLIO_URL}"
echo "Switch to your organization, then turn on PortfolioOS under Plugins."
