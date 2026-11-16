#!/usr/bin/env bash
# Sona workspace migration reconciliation (Phase 2 Track A).
# Wrapper around packages/db/scripts/sona-workspace-reconcile.js
#
# Usage:
#   bash scripts/sona-workspace-reconcile.sh --help
#   MIGRATION_DATABASE_URL=postgresql://portfolio_migrator:...@localhost:5433/portfolio_os \
#     bash scripts/sona-workspace-reconcile.sh
#
# See docs/SONA_MIGRATION.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/packages/db/scripts/sona-workspace-reconcile.js" "$@"
