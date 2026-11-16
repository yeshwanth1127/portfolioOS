#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker, then: docker compose up -d"
  exit 1
fi

docker compose up -d
export DATABASE_URL="${DATABASE_URL:-postgresql://portfolio:portfolio@localhost:5432/portfolio_os}"
npm run db:migrate
npm run db:seed

API_PID=""
cleanup() {
  if [[ -n "$API_PID" ]]; then kill "$API_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

npm run api:dev &
API_PID=$!
sleep 2

npm run test:pilot

echo "Optional WhatsApp simulation (owner self-chat, as the sidecar would send it):"
curl -s -X POST http://localhost:3938/api/v1/whatsapp/inbound \
  -H 'Content-Type: application/json' \
  -H "X-Service-Secret: ${WA_SERVICE_SECRET:-${AGENT_RUNNER_SECRET:-dev-runner-secret}}" \
  -d '{"text":"@ readiness"}' || true
