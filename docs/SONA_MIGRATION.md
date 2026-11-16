# Sona workspace migration (Phase 2 Track A)

This document covers moving **existing single-tenant PortfolioOS data** into the **Sona** workspace created by migration `010_workspaces.sql`, verifying that row counts and content fingerprints match a pre-migration baseline, and rehearsing rollback before production cutover.

Related:

- Schema and one-shot data attach: [`packages/db/migrations/010_workspaces.sql`](../packages/db/migrations/010_workspaces.sql)
- Isolation tests: [`tests/integration/workspaces.test.js`](../tests/integration/workspaces.test.js)
- Reconcile runner: [`scripts/sona-workspace-reconcile.sh`](../scripts/sona-workspace-reconcile.sh) → [`packages/db/scripts/sona-workspace-reconcile.js`](../packages/db/scripts/sona-workspace-reconcile.js)
- Deploy context: [`docs/DEPLOY.md`](DEPLOY.md)

There is **no separate `012_sona_baseline.sql`**: legacy rows are assigned inside `010_workspaces.sql` when organisations or memberships already exist. Do not hand-edit `workspace_id` in production unless you are executing a documented rollback.

---

## What migration 010 does

1. Creates `workspaces`, `workspace_members`, `whatsapp_connections`.
2. If `organisations` or `memberships` already have rows, inserts workspace **Sona** (`slug = sona`) and seeds `workspace_members` from distinct membership users (owners become workspace `owner`, others `member`).
3. Adds `workspace_id` to every business table, sets existing rows to the Sona id, then `NOT NULL` + default `app_workspace()`.
4. Rebuilds composite foreign keys `(workspace_id, …)` and adds **restrictive** RLS isolation policies.

New empty databases (test harness) skip the Sona insert block because fixtures create workspaces explicitly.

---

## Rehearsal on a production-like dump (recommended gate)

### 1. Backup

```bash
# Server example — see DEPLOY.md
docker compose -p portfolio exec -T postgres \
  pg_dump -U portfolio_migrator portfolio_os > /root/portfolio-pre-workspace-$(date +%F).sql
```

### 2. Capture baseline **before** applying 010

On the restore target (local or staging), with migrations through `009` only:

```bash
export MIGRATION_DATABASE_URL="postgresql://portfolio_migrator:PASSWORD@HOST:PORT/portfolio_os"

node packages/db/scripts/sona-workspace-reconcile.js \
  --capture-baseline /tmp/sona-pre-010.json
```

This records per-table row counts and MD5 checksums on `kpis`, `submissions`, `scores`, `org_periods`, and `organisations` (columns **exclude** `workspace_id` so fingerprints stay comparable).

### 3. Apply migration 010 (and later pending migrations)

```bash
npm run migrate -w @portfolio-os/db
# or: node packages/db/scripts/migrate.js
```

For a database that already has schema but no `schema_migrations` history, use the verified baseline path described in [`packages/db/scripts/migrate.js`](../packages/db/scripts/migrate.js) (`--baseline <file>`), not a blind re-run.

### 4. Reconcile

```bash
bash scripts/sona-workspace-reconcile.sh --baseline /tmp/sona-pre-010.json
```

Or integrity-only (no saved baseline; useful on dev after full migrate):

```bash
bash scripts/sona-workspace-reconcile.sh
```

The script **exits non-zero** on any mismatch. Use `--dry-run` to print failures without failing CI.

### 5. Application verification

```bash
npm test
```

Confirm `tests/integration/workspaces.test.js` passes (RLS, composite FK, API workspace binding).

---

## Manual verification queries

Run as `portfolio_migrator` (or superuser) so RLS does not hide rows.

**Sona workspace exists and owns all organisations:**

```sql
SELECT w.id, w.slug, count(o.id) AS orgs
FROM workspaces w
LEFT JOIN organisations o ON o.workspace_id = w.id
WHERE w.slug = 'sona'
GROUP BY w.id, w.slug;
```

**No null workspace ids on core tables:**

```sql
SELECT 'memberships' AS t, count(*) FILTER (WHERE workspace_id IS NULL) AS nulls FROM memberships
UNION ALL
SELECT 'kpis', count(*) FILTER (WHERE workspace_id IS NULL) FROM kpis
UNION ALL
SELECT 'submissions', count(*) FILTER (WHERE workspace_id IS NULL) FROM submissions;
```

**Every membership user is a workspace member:**

```sql
SELECT m.user_id, m.workspace_id
FROM memberships m
LEFT JOIN workspace_members wm USING (workspace_id, user_id)
WHERE wm.user_id IS NULL
LIMIT 20;
```

**Cross-workspace FK guard (should return no rows):**

```sql
SELECT c.conname, src.relname
FROM pg_constraint c
JOIN pg_class src ON src.oid = c.conrelid
JOIN pg_class ref ON ref.oid = c.confrelid
WHERE c.contype = 'f' AND src.relnamespace = 'public'::regnamespace
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = src.oid AND attname = 'workspace_id')
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ref.oid AND attname = 'workspace_id')
  AND NOT EXISTS (
    SELECT 1 FROM unnest(c.conkey) k
    JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k
    WHERE a.attname = 'workspace_id'
  );
```

---

## Dev database (Docker / `scripts/dev.sh`)

After `npm run migrate`, run:

```bash
export MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-postgresql://portfolio_migrator:portfolio_migrator@localhost:5433/portfolio_os}"
bash scripts/sona-workspace-reconcile.sh --no-expect-sona
```

Seed data may create additional workspaces (pilot demos); `--no-expect-sona` skips the single-tenant Sona slug assertion while still checking null `workspace_id` and composite FK shape.

---

## Rollback notes

`010_workspaces.sql` is **not reversible** in one SQL file. Rehearsed rollback:

1. **Stop** PortfolioOS API, agent-runner, and WhatsApp gateway (no new writes).
2. **Restore** the pre-migration dump taken in step 1 (or replay logical backup).
3. **Re-run** migrations only after confirming `schema_migrations` matches the restored era (often: restore includes migration history; if not, use `migrate.js --baseline` up to the last migration present in the dump).
4. **Do not** partially drop `workspace_id` columns — composite FKs and policies depend on them.

Keep the baseline JSON (`sona-pre-010.json`) with the backup so a future re-migration can be compared again.

---

## Phase 2 exit gate checklist

Full local + production steps: **[PHASE2_EXIT.md](./PHASE2_EXIT.md)**.

| Check | Command / test |
|-------|----------------|
| Row counts unchanged vs pre-010 baseline | `sona-workspace-reconcile.sh --baseline …` |
| No NULL `workspace_id` on business tables | same script (integrity mode) |
| Workspace A cannot see B | `npm test` → `workspaces.test.js` |
| Sona slug owns legacy orgs/KPIs | `sona-workspace-reconcile.sh` (default `--expect-sona`) |
| Fixture DB reconcile (CI / dev) | `npm test` → `sona-reconcile.test.js` |

---

## Open risks

- **WhatsApp connections**: pre-010 connectors may need a one-time row in `whatsapp_connections` per workspace after cutover; routing uses `auth.workspace_for_connector`. Plan linking in Settings after migrate.
- **Second workspace pilots**: counts may legitimately span workspaces; use `--no-expect-sona` and per-workspace reporting, not the single-tenant baseline compare.
- **Long migrate window**: capture baseline immediately before `010`; any writes between baseline and migrate will show as count/checksum drift.
- **Role choice**: reconciliation must use `portfolio_migrator` (or superuser). `portfolio_app` under RLS can under-count if session scope is set.
