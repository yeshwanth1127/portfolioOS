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
# Meetings: LiveKit key pair from .env, or the dev pair the API also falls back to.
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}" LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
export LIVEKIT_URL="http://localhost:7880" LIVEKIT_PUBLIC_URL="ws://localhost:7880"
# The meetings container (LiveKit): media advertised on 127.0.0.1; webhooks to the API on the host.
# Its meeting bot is off here: the bot runs natively below so it can reach Qlix's whisper-server.
LIVEKIT_NODE_IP=127.0.0.1 LIVEKIT_USE_EXTERNAL_IP=false LIVEKIT_WEBHOOK_URL=http://host.docker.internal:4001/livekit/webhook \
  MEETING_BOT_AUTOSTART=false docker compose up -d --build meetings 2>&1 | tag meetings
export QLIX_BACKEND_URL="http://localhost:4000"                 # .env has host.docker.internal for Docker
# App services connect as portfolio_app (row-level security applies); migrations and seeding as
# portfolio_migrator. Roles are created/refreshed below by the Docker superuser (docs/BUILD.md § 4.12).
export ADMIN_DATABASE_URL="postgresql://portfolio:portfolio@localhost:5433/portfolio_os"
export DATABASE_URL="postgresql://portfolio_app:${APP_DB_PASSWORD:-portfolio_app}@localhost:5433/portfolio_os"
export MIGRATION_DATABASE_URL="postgresql://portfolio_migrator:${MIGRATOR_DB_PASSWORD:-portfolio_migrator}@localhost:5433/portfolio_os"
export AGENT_RUNNER_URL="http://localhost:3940" PORTFOLIOOS_API_URL="http://localhost:4001"
export NEXT_PUBLIC_API_URL="http://localhost:4001" QLIX_ADK_PATH="$EXORA/qlix-monorepo/adk_new"

echo "database roles…"
MIGRATOR_PASSWORD="${MIGRATOR_DB_PASSWORD:-portfolio_migrator}" APP_PASSWORD="${APP_DB_PASSWORD:-portfolio_app}" \
  node packages/db/scripts/bootstrap.js --adopt-from portfolio 2>&1 | tag db
echo "migrations…"
npm run migrate -w @portfolio-os/db 2>&1 | tag db
# grants for anything the migrations just created
MIGRATOR_PASSWORD="${MIGRATOR_DB_PASSWORD:-portfolio_migrator}" APP_PASSWORD="${APP_DB_PASSWORD:-portfolio_app}" \
  node packages/db/scripts/bootstrap.js 2>&1 | tag db
n=$(docker compose exec -T postgres psql -U portfolio -d portfolio_os -tAc "select count(*) from organisations" 2>/dev/null || echo 0)
[[ "${n// /}" == "0" ]] && npm run seed -w @portfolio-os/db 2>&1 | tag db
node packages/db/scripts/register-connector.js sona 2>&1 | tag db
if [[ -n "${DEMO_PASSWORD:-}" ]]; then   # replace the seeded password123 with DEMO_PASSWORD
  node packages/db/scripts/set-demo-password.js 2>&1 | tag db
  export NEXT_PUBLIC_DEMO_PASSWORD="$DEMO_PASSWORD"
fi

# --- Processes (all watched) ----------------------------------------------------
if up 4000; then echo "[qlix] backend-adk already on :4000 — reusing"
# Clean env: our .env exports PORT/DATABASE_URL/JWT_SECRET/… which would override backend-adk/.env
else (cd "$QLIX" && env -i HOME="$HOME" PATH="$PATH" TERM="${TERM:-xterm}" PORT=4000 npm run dev 2>&1 | tag qlix) & fi

node --watch packages/api/src/index.js 2>&1 | tag api &
AGENT_RUNNER_PORT=3940 node --watch services/agent-runner/src/index.js 2>&1 | tag runner &
WA_PORT=3938 WA_SERVICE_URL=http://127.0.0.1:3939 node --watch services/wa-gateway/src/index.js 2>&1 | tag wa-gw &
(cd apps/web && npx next dev -p 3001 2>&1 | tag web) &
(cd "$WA" && PORT=3939 NODE_ENV=development QLIX_URL=http://127.0.0.1:3938 QLIX_REQUEST_TIMEOUT_MS=120000 QLIX_CALLBACK_RETRIES=0 \
   SERVICE_SECRET="$WA_SERVICE_SECRET" WHATSAPP_BIND_HOST=127.0.0.1 \
   WHATSAPP_AUTH_DIR="$LIVE/wa-auth" WHATSAPP_DATA_DIR="$LIVE/wa-data" \
   node src/index.js 2>&1 | tag whatsapp) &

# Meeting Assistant: Qlix's whisper.cpp speech-to-text on :8178 (reused if Qlix already runs one
# there), and the meeting bot that LiveKit sends into calls (docs/MEETINGS.md).
BOT="$SONA/services/meeting-bot"
WHISPER_MODEL="${QLIX_WHISPER_MODEL:-}"
for m in "$EXORA/qlix-final/qlix_desktop/desktop-agent/models/ggml-base.en.bin" "$EXORA/qlix/qlix_desktop/desktop-agent/models/ggml-base.en.bin"; do
  [[ -z "$WHISPER_MODEL" && -f "$m" ]] && WHISPER_MODEL="$m"
done
if up 8178; then echo "[stt] whisper-server already on :8178 — reusing"
elif command -v whisper-server >/dev/null && [[ -n "$WHISPER_MODEL" ]]; then
  whisper-server -m "$WHISPER_MODEL" --host 127.0.0.1 --port 8178 -t 6 2>&1 | tag stt &
else echo "[stt] no whisper-server/model found (brew install whisper-cpp; set QLIX_WHISPER_MODEL) — meetings run without notes"; fi
if [[ ! -x "$BOT/.venv/bin/python" ]]; then
  echo "[bot] creating venv…"
  { "${PORTFOLIO_PYTHON:-/opt/homebrew/bin/python3.12}" -m venv "$BOT/.venv" && "$BOT/.venv/bin/pip" install -q -r "$BOT/requirements.txt"; } 2>&1 | tag bot
fi
(cd "$BOT" && LIVEKIT_URL=ws://localhost:7880 PORTFOLIOOS_API_URL=http://localhost:4001 AGENT_RUNNER_URL=http://localhost:3940 QLIX_STT_URL=http://127.0.0.1:8178 \
   .venv/bin/python bot.py start 2>&1 | tag bot) &

for _ in $(seq 1 60); do up 3001 && up 4001 && break; sleep 2; done
echo
echo "================  DEV LIVE → http://localhost:3001  ================"
echo "  web: edit + refresh   ·   api/runner/gateway: auto-restart on save"
echo "  Python ADK changes apply on the next agent message (new process per turn)"
echo "  meetings: LiveKit on ws://localhost:7880 · Meeting Assistant bot + whisper-server :8178"
echo "  Ctrl+C to stop"
echo "===================================================================="
wait
