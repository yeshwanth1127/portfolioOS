#!/usr/bin/env bash
# Start PortfolioOS in its own containers, on the shared Docker network `exora`.
# Qlix reaches it as http://portfolio:4001. Your browser and the desktop app use
# http://127.0.0.1:3001.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"
fi
docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }

# Talk to the Qlix backend container, not a process on the host.
export QLIX_BACKEND_URL="${QLIX_BACKEND_URL_OVERRIDE:-http://backend:4000}"

docker compose up -d --build

echo "Waiting for PortfolioOS…"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT:-3001}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo
echo "PortfolioOS is live → http://127.0.0.1:${WEB_PORT:-3001}"
echo "Sign in as owner@portfolio.local (password is DEMO_PASSWORD in .env)."
echo "Qlix containers call it at http://portfolio:4001 on the exora network."
