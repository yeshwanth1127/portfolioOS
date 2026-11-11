#!/usr/bin/env bash
# Bring up Qlix backend-adk (:4000) + full PortfolioOS stack locally on macOS.
#   bash ~/EXORA/sona-ecosystem/scripts/go-live-local.sh        start
#   bash ~/EXORA/sona-ecosystem/scripts/go-live-local.sh stop   stop
set -euo pipefail
EXORA="$(cd "$(dirname "$0")/../.." && pwd)"
SONA="$EXORA/sona-ecosystem"
QLIX="$EXORA/qlix-monorepo/backend-adk"
LOG="$SONA/.live"
mkdir -p "$LOG"

wait_http() { # url name seconds
  for _ in $(seq 1 "$3"); do curl -fsS "$1" >/dev/null 2>&1 && { echo "  ✓ $2"; return 0; }; sleep 2; done
  echo "  ✗ $2 not up ($1) — see logs in $LOG"; return 1
}

if [[ "${1:-}" == "stop" ]]; then
  [[ -f "$LOG/backend.pid" ]] && kill "$(cat "$LOG/backend.pid")" 2>/dev/null || true
  (cd "$SONA" && docker compose down)
  docker stop qlix-local-pg qlix-local-redis >/dev/null 2>&1 || true
  echo "stopped"; exit 0
fi

echo "1/5 Docker"
if ! docker info >/dev/null 2>&1; then
  open -a Docker
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
docker info >/dev/null 2>&1 || { echo "Docker Desktop is not running"; exit 1; }

echo "2/5 Qlix Postgres :5434 + Redis :6379"
ensure_container() { # name, port, run-args...
  local name="$1" port="$2"; shift 2
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]] && nc -z 127.0.0.1 "$port" 2>/dev/null; then
    echo "  ✓ :$port already served by another process/container — using it"; return 0
  fi
  if docker container inspect "$name" >/dev/null 2>&1; then
    [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == "true" ]] || docker start "$name" >/dev/null \
      || { echo "  could not start $name:"; docker start "$name"; exit 1; }
  else
    docker run -d --name "$name" "$@" >/dev/null
  fi
  echo "  ✓ $name"
}
ensure_container qlix-local-pg 5434 -e POSTGRES_USER=qlix -e POSTGRES_PASSWORD=qlix -e POSTGRES_DB=qlix \
  -p 127.0.0.1:5434:5432 -v qlix_local_pg:/var/lib/postgresql/data pgvector/pgvector:pg16
ensure_container qlix-local-redis 6379 -p 127.0.0.1:6379:6379 redis:7-alpine
for _ in $(seq 1 30); do nc -z 127.0.0.1 5434 >/dev/null 2>&1 && break; sleep 1; done

echo "3/5 backend-adk :4000"
cd "$QLIX"
[[ -d node_modules ]] || npm install
npx prisma generate >"$LOG/prisma.log" 2>&1
npx prisma migrate deploy >>"$LOG/prisma.log" 2>&1 || { echo "prisma migrate failed — $LOG/prisma.log"; exit 1; }
if curl -fsS http://localhost:4000/api/v1/health >/dev/null 2>&1; then
  echo "  (already running)"
else
  nohup npm run dev >"$LOG/backend.log" 2>&1 &
  echo $! >"$LOG/backend.pid"
fi
wait_http http://localhost:4000/api/v1/health "backend-adk" 60

echo "4/5 PortfolioOS container (build can take a few minutes first time)"
cd "$SONA"
docker compose up --build -d >"$LOG/compose.log" 2>&1 || { tail -40 "$LOG/compose.log"; exit 1; }

echo "5/5 health"
wait_http http://localhost:4001/health "API :4001" 90
wait_http http://localhost:3940/health "agent-runner :3940" 30
wait_http http://localhost:3938/health "wa-gateway :3938" 30
wait_http http://localhost:3001 "web :3001" 60

echo
echo "LIVE → http://localhost:3001   (owner@portfolio.local / password123)"
echo "Logs: docker compose -f $SONA/docker-compose.yml logs -f   |   $LOG/backend.log"
