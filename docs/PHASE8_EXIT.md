# Phase 8 exit gate — Commercial pilot

Spec: [BUILD.md §12](./BUILD.md#12-phase-8--commercial-pilot) · Roadmap: [ROADMAP.md § Phase 8](./ROADMAP.md#phase-8--commercial-pilot)

**Production exit gate:** Sona and one external customer on pilot for four weeks with manageable support (deferred here).

**Local gate (this document):** schema, entitlements, usage, onboarding, portability, ops middleware, integration tests, support runbook stubs — same standard as Phases 4–7.

## Slice 8.0 — Schema `020_commercial.sql`

- [x] `plans`, `workspace_entitlements`, `workspace_usage_daily`, `workspace_export_jobs`, `workspace_deletion_requests`
- [x] RLS: workspace-scoped tables with restrictive isolation; `plans` globally readable
- [x] `auth.set_workspace_entitlement`, `auth.bump_usage`, `auth.workspace_plan_features`; `actor_for_membership` exposes `plan_code` + `plan_features`
- [x] Trigger: new workspaces receive pilot entitlement

## Slice 8.1 — Entitlements in `can()`

- [x] `feature.*` prefix in `can()`; `requireFeature()` + `features.js`
- [x] Manual provisioning: `POST /admin/workspaces/:id/entitlements` (`x-admin-secret`) and owner `POST /workspaces/:id/entitlements`
- [x] Default pilot plan backfilled; matrix `permissions.csv` unchanged (features are plan-gated, not role matrix)

## Slice 8.2 — Usage tracking

- [x] Hooks: login (`active_users`), agent `logToolCall` (`agent_tool_calls`), WA outbox enqueue (`wa_messages` in task/calendar jobs)
- [x] `GET /admin/usage?workspace_id=` (owner)

## Slice 8.3 — Onboarding

- [x] `POST /onboarding/import-csv` (dry-run token)
- [x] `POST /onboarding/apply`
- [x] `scripts/seed-demo-workspace.js`
- [x] Web `/onboarding` wizard (owner only)

## Slice 8.4 — Portability

- [x] `POST /workspace/export` → `workspace_export` job (manifest + people/kpis/projects CSVs)
- [x] `POST /workspace/delete-request` → grace + `workspace_purge` job (demo / test-safe unless `ALLOW_WORKSPACE_PURGE=1`)

## Slice 8.5 — Security & ops (local)

- [x] Rate limits: `POST /auth/login`, `POST /agent/tools/portfolio_os` (in-memory; prod → Redis — see DEPLOY)
- [x] `x-request-id` middleware
- [x] `GET /audit-log` (owner)
- [x] [DEPLOY.md](./DEPLOY.md) Phase 8 notes; [SUPPORT_RUNBOOK.md](./SUPPORT_RUNBOOK.md); `scripts/backup-workspace.sh`
- [x] Optional `SENTRY_DSN` hook documented (no SaaS wiring in local gate)

## Slice 8.6 — Tests

- [x] `tests/integration/commercial-pilot.test.js` — entitlements, CSV dry/apply, export job, usage, rate limit, audit log, request id
- [x] Full suite + web build (see gate table)

## Phase 8 gate-ready (local)

| Check | Command / artefact |
|-------|-------------------|
| Commercial slice | `tests/integration/commercial-pilot.test.js` |
| Migrations | `020_commercial.sql` |
| Full suite | `npm test` (**133** tests) |
| Web build | `npm run build -w @portfolio-os/web` |

## Production deferrals

- [ ] **4-week pilot** with Sona + external customer (ROADMAP exit gate)
- [ ] Redis-backed rate limits and centralized session revocation
- [ ] Self-service billing / Stripe (Phase 9)
- [ ] Full Sentry (or equivalent) integration beyond env hook
- [ ] Automated daily backup cron + monthly restore drill on production host (commands in SUPPORT_RUNBOOK)

## Files added / changed (main)

| Area | Path |
|------|------|
| Migration | `packages/db/migrations/020_commercial.sql` |
| Features | `packages/api/src/core/permissions/{features,can}.js` |
| Commercial | `packages/api/src/modules/commercial/*.js` |
| Middleware | `packages/api/src/middleware/{request-id,rate-limit}.js` |
| Routes | `packages/api/src/routes.js`, `app.js` |
| Web | `apps/web/app/onboarding/page.js` |
| Scripts | `scripts/{seed-demo-workspace,backup-workspace}.sh` |
| Docs | `docs/PHASE8_EXIT.md`, `docs/SUPPORT_RUNBOOK.md`, `docs/DEPLOY.md`, `docs/ROADMAP.md` |
| Tests | `tests/integration/commercial-pilot.test.js` |
