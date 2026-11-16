#!/usr/bin/env bash
# Phase 0 deploy verification (docs/BUILD.md § 4.15, docs/DEPLOY.md).
# Usage (on server):
#   bash scripts/phase0-server-checks.sh
#   SONA=/opt/exora/sona-ecosystem bash scripts/phase0-server-checks.sh
set -euo pipefail

SONA="${SONA:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-$SONA/.env}"
WEB_PORT="${WEB_PORT:-3101}"
WA_AUTH_VOLUME="${WA_AUTH_VOLUME:-portfolio_wa_auth}"
COMPOSE=(docker compose -p portfolio --project-directory "$SONA" -f "$SONA/docker-compose.yml" -f "$SONA/docker-compose.server.yml")

ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*"; FAILED=1; }

FAILED=0

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

ROLE_LINE="$("${COMPOSE[@]}" exec -T portfolio node -e "
const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect()
  .then(()=>c.query('SELECT rolsuper::text, rolbypassrls::text FROM pg_roles WHERE rolname = current_user'))
  .then((r)=>{console.log(r.rows.map((x)=>Object.values(x).join('|')).join('|'));return c.end();})
  .catch(()=>process.exit(2));
" 2>/dev/null || true)"
ROLE_LINE="${ROLE_LINE//$'\n'/}"
if [[ "${DATABASE_URL:-}" == *"portfolio_app@"* ]]; then
  ok "DATABASE_URL uses portfolio_app"
elif [[ -n "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL must use portfolio_app (not the legacy portfolio superuser)"
else
  warn "DATABASE_URL not loaded — skipped role-user check"
fi

if [[ "$ROLE_LINE" == "f|f" ]]; then
  ok "database connects as portfolio_app without superuser or BYPASSRLS ($ROLE_LINE)"
elif [[ -n "$ROLE_LINE" ]]; then
  fail "portfolio_app role check: expected f|f, got $ROLE_LINE (run bootstrap + point DATABASE_URL at portfolio_app)"
else
  warn "portfolio stack not running — skipped database role probe"
fi

if ss -ltnp 2>/dev/null | grep -E "0\.0\.0\.0:(${WEB_PORT}|4001|3938|3939|3940|5433)\\b" >/dev/null; then
  fail "a service port is bound on 0.0.0.0 (web/API/gateway/runner/Postgres must be 127.0.0.1 or Docker-internal only)"
else
  ok "no Portfolio ports on 0.0.0.0 (${WEB_PORT}, 4001, 3938–3940, 5433)"
fi

if ss -ltnp 2>/dev/null | grep -E "127\.0\.0\.1:${WEB_PORT}\\b" >/dev/null; then
  ok "web listens on 127.0.0.1:${WEB_PORT} (nginx may bind 80/443)"
elif command -v ss >/dev/null 2>&1; then
  warn "nothing listening on 127.0.0.1:${WEB_PORT} (stack down or WEB_PORT mismatch)"
fi

if docker volume inspect "$WA_AUTH_VOLUME" >/dev/null 2>&1; then
  ok "WhatsApp auth volume present ($WA_AUTH_VOLUME)"
else
  warn "WhatsApp auth volume $WA_AUTH_VOLUME missing — backup path: docker run --rm -v ${WA_AUTH_VOLUME}:/data … (see docs/DEPLOY.md)"
fi

for name in JWT_SECRET AGENT_RUNNER_SECRET WA_SERVICE_SECRET; do
  val="${!name:-}"
  if [[ -z "$val" || ${#val} -lt 32 ]]; then
    fail "$name missing or shorter than 32 characters"
  elif [[ "$val" == "dev-runner-secret" || "$val" == "dev-portfolio-os-secret-change-in-prod" ]]; then
    fail "$name is still a known development default"
  else
    ok "$name length OK"
  fi
done

if [[ -z "${WHATSAPP_AUTH_ENCRYPTION_KEY:-}" ]]; then
  fail "WHATSAPP_AUTH_ENCRYPTION_KEY not set — sessions cannot survive restart/backup restore"
else
  ok "WHATSAPP_AUTH_ENCRYPTION_KEY is set"
  warn "store WHATSAPP_AUTH_ENCRYPTION_KEY in your secret store and backup with DB/wa-auth dumps (tarball alone cannot decrypt)"
fi

if curl -fsS "http://127.0.0.1:${WEB_PORT}/papi/health" >/dev/null 2>&1; then
  ok "PortfolioOS API health (${WEB_PORT})"
else
  warn "could not reach /papi/health on 127.0.0.1:${WEB_PORT}"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo
  echo "One or more Phase 0 checks failed. See docs/DEPLOY.md § Phase 0 server checks."
  exit 1
fi
echo
echo "Phase 0 server checks passed."
