#!/usr/bin/env bash
# PortfolioOS dev mode on macOS — everything runs natively with file watching.
# Edit code → refresh the browser. Ctrl+C stops everything this script started.
#   bash ~/EXORA/sona-ecosystem/scripts/dev.sh
set -uo pipefail
EXORA="$(cd "$(dirname "$0")/../.." && pwd)"
SONA="$EXORA/sona-ecosystem"
QLIX="$EXORA/qlix-monorepo/backend-adk"
WA="$EXORA/qlix-monorepo/platform/qlix-whatsapp-service"
LIVE="$SONA/.live"; mkdir -p "$LIVE/wa-auth" "$LIVE/wa-data"

trap 'echo; echo "stopping…"; kill 0 2>/dev/null; exit 0' INT TERM
tag() { awk -v t="$1" '{ printf "[%s] %s\n", t, $0; fflush() }'; }
up() { nc -z 127.0.0.1 "$1" 2>/dev/null; }

# --- Docker infra ---------------------------------------------------------------
docker info >/dev/null 2>&1 || { open -a Docker; for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done; }
docker info >/dev/null 2>&1 || { echo "Docker Desktop is not running"; exit 1; }
for c in qlix-local-pg qlix-local-redis; do
  [[ "$(docker inspect -f '{{.State.Running}}' $c 2>/dev/null)" == "true" ]] || docker start $c >/dev/null 2>&1 || true
done
cd "$SONA"
docker compose stop portfolio >/dev/null 2>&1 || true          # free ports 3001/4001/3938-3940
docker compose up -d postgres >/dev/null
for _ in $(seq 1 30); do up 5433 && break; sleep 1; done

# --- Env ------------------------------------------------------------------------
set -a; source "$SONA/.env"; set +a
export QLIX_BACKEND_URL="http://localhost:4000"                 # .env has host.docker.internal for Docker
export DATABASE_URL="postgresql://portfolio:portfolio@localhost:5433/portfolio_os"
export AGENT_RUNNER_URL="http://localhost:3940" PORTFOLIOOS_API_URL="http://localhost:4001"
export NEXT_PUBLIC_API_URL="http://localhost:4001" QLIX_ADK_PATH="$EXORA/qlix-monorepo/adk_new"

echo "migrations…"
npm run migrate -w @portfolio-os/db 2>&1 | tag db
n=$(docker compose exec -T postgres psql -U portfolio -d portfolio_os -tAc "select count(*) from organisations" 2>/dev/null || echo 0)
[[ "${n// /}" == "0" ]] && npm run seed -w @portfolio-os/db 2>&1 | tag db
if [[ -n "${DEMO_PASSWORD:-}" ]]; then   # replace the seeded password123 with DEMO_PASSWORD
  docker compose exec -T postgres psql -U portfolio -d portfolio_os -qc \
    "UPDATE users SET password_hash = encode(digest('portfolio-os:' || '$DEMO_PASSWORD', 'sha256'), 'hex')
     WHERE password_hash = encode(digest('portfolio-os:password123', 'sha256'), 'hex')" >/dev/null && echo "[db] demo logins use DEMO_PASSWORD from .env"
  export NEXT_PUBLIC_DEMO_PASSWORD="$DEMO_PASSWORD"
fi

# --- Processes (all watched) ----------------------------------------------------
if up 4000; then echo "[qlix] backend-adk already on :4000 — reusing"
else (cd "$QLIX" && npm run dev 2>&1 | tag qlix) & fi

node --watch packages/api/src/index.js 2>&1 | tag api &
AGENT_RUNNER_PORT=3940 node --watch services/agent-runner/src/index.js 2>&1 | tag runner &
WA_PORT=3938 WA_SERVICE_URL=http://127.0.0.1:3939 node --watch services/wa-gateway/src/index.js 2>&1 | tag wa-gw &
(cd apps/web && npx next dev -p 3001 2>&1 | tag web) &
(cd "$WA" && PORT=3939 NODE_ENV=development QLIX_URL=http://127.0.0.1:3938 QLIX_REQUEST_TIMEOUT_MS=120000 QLIX_CALLBACK_RETRIES=0 \
   SERVICE_SECRET="$WA_SERVICE_SECRET" WHATSAPP_BIND_HOST=127.0.0.1 \
   WHATSAPP_AUTH_DIR="$LIVE/wa-auth" WHATSAPP_DATA_DIR="$LIVE/wa-data" \
   node src/index.js 2>&1 | tag whatsapp) &

for _ in $(seq 1 60); do up 3001 && up 4001 && break; sleep 2; done
echo
echo "================  DEV LIVE → http://localhost:3001  ================"
echo "  web: edit + refresh   ·   api/runner/gateway: auto-restart on save"
echo "  Python ADK changes apply on the next agent message (new process per turn)"
echo "  Ctrl+C to stop"
echo "===================================================================="
wait
