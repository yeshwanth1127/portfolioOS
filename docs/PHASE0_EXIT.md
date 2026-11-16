# Phase 0 exit checklist (F1–F15)

One-page gate before calling Phase 0 done on **production**. Local steps use this repo; server steps use [DEPLOY.md](./DEPLOY.md).

| Step | Done when | Verify (local or server) |
|------|-----------|--------------------------|
| **F1** | Integration harness + CI | `npm test` from clean checkout |
| **F2** | Migration runner baseline | `tests/integration/migrations.test.js` |
| **F3** | `withSession` rolls back on `{ error }` | `tests/integration/transactions.test.js` |
| **F4** | Period lock races | `tests/concurrency/period-lock.test.js` |
| **F5** | Submission state machine | `tests/integration/submissions.test.js` |
| **F6** | Approval scope | cross-org cases in submission suites |
| **F7** | IST `todayIn` | `tests/integration/dates.test.js` |
| **F8** | scrypt passwords | auth tests; no SHA-256 writes in seed/entrypoint |
| **F9** | Production secret guard | start API/runner/gateway with dev secrets → non-zero exit |
| **F10** | WhatsApp identity | `tests/integration/whatsapp*.test.js` |
| **F11** | Auth bootstrap definer fns | auth + RLS tests |
| **F12** | `portfolio_migrator` / `portfolio_app` roles | Docker entrypoint + `DATABASE_URL` uses `portfolio_app` |
| **F13** | Short transactions + `FORCE RLS` | `tests/integration/isolation.test.js` |
| **F14** | ADK committed generic catalogue client | [F14-adk-coordination.md](./F14-adk-coordination.md); pin `QLIX_MONOREPO_SHA` |
| **F15** | Server checks + backups | `bash scripts/phase0-server-checks.sh` on server; manual backup commands in DEPLOY |

## F15 commands (production)

```bash
# Role (must print f|f)
docker compose -p portfolio exec -T postgres \
  psql "$DATABASE_URL" -U portfolio_app -d portfolio_os \
  -tAc "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"

# Ports: only nginx on 0.0.0.0:80/443; web on 127.0.0.1:3101
ss -ltnp | grep -E ':(80|443|3101|4001|3938|3939|3940|5433) '

# Automated bundle (secrets, role, ports, wa volume, health)
WEB_PORT=3101 bash /opt/exora/sona-ecosystem/scripts/phase0-server-checks.sh

# Backup pair (key must live in secret store, not only .env)
docker compose -p portfolio exec -T postgres pg_dump -U portfolio_migrator portfolio_os \
  > "/root/portfolio-$(date +%F).sql"
docker run --rm -v portfolio_wa_auth:/data -v /root:/backup alpine \
  tar czf "/backup/wa-auth-$(date +%F).tar.gz" -C /data .
grep WHATSAPP_AUTH_ENCRYPTION_KEY /opt/exora/sona-ecosystem/.env   # copy value to backups/vault
```

**Exit gate (ROADMAP):** all F1–F15 rows satisfied; tests cover cross-org access, locked periods, WhatsApp identity, and migration failure; production runs as `portfolio_app` with forced RLS.
