# PortfolioOS — support runbook (Phase 8 local gate)

Ops companion to [DEPLOY.md](./DEPLOY.md). Production pilot support expands in the 4-week gate (deferred).

## Contacts & severity

| Severity | Meaning | Target response (pilot) |
|----------|---------|-------------------------|
| S1 | Workspace down, data loss risk | Immediate |
| S2 | Core journey blocked (login, submit, approve) | Same business day |
| S3 | Degraded (agent slow, WA delay) | Next business day |
| S4 | Question / how-to | When convenient |

## Backups

**PostgreSQL**

```bash
bash scripts/backup-workspace.sh
# or on server: see DEPLOY.md § Backups
```

**WhatsApp session**

- Docker volume `portfolio_wa_auth` (tarball daily alongside DB)
- Secret `WHATSAPP_AUTH_ENCRYPTION_KEY` in the same secrets store as JWT / DB passwords

## Restore drill checklist (monthly)

1. Restore latest `portfolio-*.sql` to a **scratch** database; run `npm test` or smoke login against scratch.
2. Restore `wa-auth-*.tar.gz` to a test volume with the **same** encryption key.
3. Confirm WhatsApp status in Settings without re-pairing (or document QR re-scan if key mismatch).
4. Log outcome in the ops journal (date, engineer, pass/fail).

## Rollback by image tag

1. Note current compose image tag / git SHA deployed.
2. `docker compose -p portfolio pull` previous tag (or checkout prior release commit).
3. Run migrations **only** if the prior release is forward-compatible; otherwise restore DB from pre-deploy dump.
4. `docker compose -p portfolio up -d` and run `scripts/phase0-server-checks.sh`.

## Workspace export / deletion (customer requests)

- **Export:** owner calls `POST /workspace/export` or UI flow; job writes CSVs under `WORKSPACE_EXPORT_DIR` (default OS temp). Deliver zip via secure channel.
- **Deletion:** `POST /workspace/delete-request` schedules purge after grace (default 7 days). Production purge requires `ALLOW_WORKSPACE_PURGE=1` and runbook approval.

## Entitlements (manual provisioning)

```bash
curl -X POST "$API/admin/workspaces/$WORKSPACE_ID/entitlements" \
  -H "x-admin-secret: $PORTFOLIO_ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"plan_code":"pilot"}'
```

Plans are defined in migration `020_commercial.sql` (`pilot`, `limited` for tests).

## Usage & audit

- Owner: `GET /admin/usage?workspace_id=` — daily counters.
- Owner: `GET /audit-log` — permission allow/deny trail (Phase 4+).

## Monitoring (deferred)

- Set `SENTRY_DSN` when error monitoring SaaS is chosen; API logs include `x-request-id` for correlation.
- Rate limits are in-process until Redis is configured (`RATE_LIMIT_*` env vars in DEPLOY).

## Known local-gate limitations

- Onboarding CSV apply is best-effort for people rows (no full invitation mail flow).
- Export zip packaging is directory-based; streaming zip for large workspaces is a prod enhancement.
- `workspace_purge` in tests marks workspace `closed` without deleting integration fixture data destructively.
