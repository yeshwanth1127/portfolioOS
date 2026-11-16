#!/usr/bin/env bash
# Phase 8 backup stub — Postgres dump + WhatsApp auth volume note (see docs/SUPPORT_RUNBOOK.md).
set -euo pipefail
ROOT="${ROOT:-/root}"
STAMP="$(date +%F-%H%M)"
OUT="${ROOT}/portfolio-backups"
mkdir -p "$OUT"

if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump "$DATABASE_URL" > "${OUT}/portfolio-${STAMP}.sql"
  echo "Wrote ${OUT}/portfolio-${STAMP}.sql"
elif command -v docker >/dev/null && docker compose -p portfolio ps postgres >/dev/null 2>&1; then
  docker compose -p portfolio exec -T postgres pg_dump -U portfolio_migrator portfolio_os \
    > "${OUT}/portfolio-${STAMP}.sql"
  echo "Wrote ${OUT}/portfolio-${STAMP}.sql (via docker compose)"
else
  echo "Set DATABASE_URL or run on a host with portfolio docker compose." >&2
  exit 1
fi

echo "WhatsApp: also archive volume portfolio_wa_auth and WHATSAPP_AUTH_ENCRYPTION_KEY from .env"
echo "Example: docker run --rm -v portfolio_wa_auth:/data -v ${OUT}:/backup alpine \\"
echo "  tar czf /backup/wa-auth-${STAMP}.tar.gz -C /data ."
