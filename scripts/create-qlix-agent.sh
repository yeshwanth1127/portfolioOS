#!/usr/bin/env bash
# Create the Qlix login + hybrid agent PortfolioOS uses, and print the two .env lines.
#   bash scripts/create-qlix-agent.sh [qlix_url] [email]
set -euo pipefail
QLIX="${1:-http://localhost:4000}"
EMAIL="${2:-portfolio@exora.local}"
PW="${QLIX_AGENT_PASSWORD:-$(openssl rand -hex 12)}"
command -v jq >/dev/null || { echo "install jq first"; exit 1; }
curl -fsS -X POST "$QLIX/api/v1/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"displayName\":\"PortfolioOS\"}" >/dev/null 2>&1 || true
TOKEN=$(curl -fsS -X POST "$QLIX/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | jq -r .token)
[[ "$TOKEN" != "null" && -n "$TOKEN" ]] || { echo "login failed (existing account? set QLIX_AGENT_PASSWORD)"; exit 1; }
OUT=$(curl -fsS -X POST "$QLIX/api/v1/agents" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"PortfolioOS agent","permissionScopes":["web.read"],"runtime":"hybrid","model":"openrouter/openai/gpt-4o-mini","llmMode":"proxy","localInferenceMode":null,"clientPlatform":"linux"}')
echo "# Qlix login: $EMAIL / $PW"
echo "QLIX_AGENT_ID=$(echo "$OUT" | jq -r .agent.id)"
echo "QLIX_RUNNER_TOKEN=$(echo "$OUT" | jq -r .sdkAgentFile.runner_token)"
