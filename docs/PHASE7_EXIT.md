# Phase 7 exit gate — Dashboards & analytics

Spec: [BUILD.md §11](./BUILD.md#11-phase-7--dashboards--analytics) · Roadmap: [ROADMAP.md § Phase 7](./ROADMAP.md#phase-7--dashboards--analytics)

**Exit gate:** reconciliation tests prove every displayed measure equals an independent query over source records (tolerance: exact integer counts; rates rounded to 3 decimal places).

## Slice 7.0 — Analytics service layer

- [x] `packages/api/src/modules/dashboards/scope.js` — scope filters (workspace, unit subtree, project, `me`, date range).
- [x] `packages/api/src/modules/dashboards/measures.js` — four measures, each with `value`, `as_of`, `coverage`, `drill_down`:
  - **task_completion** — tasks `done` vs open (non-cancelled); coverage = assignee share.
  - **target_attainment** — `period_results` (latest revision at `as_of`) post `LEDGER_CUTOFF_DATE`; legacy `scores` pre-cutoff with label.
  - **on_time_delivery** — tasks + milestones due in range: `done` with `completed_at::date <= due_on` vs late; open past `as_of` = `open_overdue` ([definition in code](./../packages/api/src/modules/dashboards/measures.js)).
  - **reporting_completeness** — ledger: active metrics vs metrics with approved report in period; legacy: KPI×day vs submissions in `submitted|validated|locked`.

## Slice 7.1 — HTTP endpoints

- [x] `GET /dashboards/overview` — Overview v1 unchanged for cards; adds `measures` + `freshness`; Delivery/Target cards include `as_of` + `coverage`.
- [x] `GET /dashboards/owner` — workspace rollups (owner only).
- [x] `GET /dashboards/unit/:id` — unit subtree (org-scoped access).
- [x] `GET /dashboards/project/:id` — project scoped.
- [x] `GET /dashboards/me` — contributor (`assignee` / milestone owner).
- [x] `GET /dashboards/drill-down?measure=` — measure block + drill params.
- [x] `GET /reports/summary` — role-aware summary (owner → workspace; else org or `me`).
- [x] `GET /reports/export.csv` — same measures as CSV.

## Slice 7.2 — Reconciliation tests

- [x] `tests/integration/dashboards-reconciliation.test.js` — API vs independent SQL for task completion and reporting completeness; on-time fixtures; CSV vs summary; digest job snapshot.

## Slice 7.3 — Reports UI + CSV

- [x] `apps/web/app/reports/page.js` — measure table, date filters, export.
- [x] Sidebar **Reports** link (`app-shell.js`).

## Slice 7.4 — Digest job

- [x] `packages/api/src/jobs/digest.js` — `workspace_digest` handler calls owner dashboard service; in-app `notifications` + optional `wa_outbox`.
- [x] `POST /digest/run` — reuses `ownerDigestSnapshot` + `formatDigestBody` (05:30 cron unchanged; enqueue `workspace_digest` in ops).

## Slice 7.5 — Web polish

- [x] Overview Delivery / Target attainment show `as_of` and coverage (`overview-v1.js`).

## Phase 7 gate-ready (local)

| Check | Command / artefact |
|-------|-------------------|
| Reconciliation | `tests/integration/dashboards-reconciliation.test.js` |
| Overview regression | `tests/integration/calendar.test.js`, `my-work.test.js` |
| Full suite | `npm test` (**133** tests; includes Phase 8 commercial slice) |
| Web build | `npm run build -w @portfolio-os/web` |

## Files added / changed (main)

| Area | Path |
|------|------|
| Service | `packages/api/src/modules/dashboards/{scope,measures,index}.js` |
| Jobs | `packages/api/src/jobs/digest.js` |
| Routes | `packages/api/src/routes.js` |
| Overview | `packages/api/src/modules/overview.js` |
| Web | `apps/web/app/reports/page.js`, `app-shell.js`, `overview-v1.js`, `lib/api.js` |
| Tests | `tests/integration/dashboards-reconciliation.test.js` |

## How reconciliation works

1. Test fixture seeds tasks (open, on-time done, late done) and a legacy submission for `asOf`.
2. `GET /dashboards/owner` returns structured `measures`.
3. Same scope object drives **independent** SQL in the test file (duplicate of measure logic, not imported) — counts must match exactly.
4. Rates (`completion_rate`, `on_time_rate`, `coverage`) use `round(num/den, 3)`; tests assert integer components.
5. Digest job runs `workspace_digest`; notification body must include owner dashboard task counts.

## Production deferrals

- [ ] p95 &lt; 300 ms rollups on pilot data volume (materialised views if needed).
- [ ] Scheduled `workspace_digest` enqueue at 05:30 workspace time in production worker/cron.
- [ ] Full per-role dashboard pages (Reports hub + role switcher is the local gate UI).

## Known limitations (local gate)

- Drill-down returns measure metadata only (no row payload yet).
- Manager `reports/summary` uses org workspace scope, not branch picker.
- Trend/comparison series deferred (BUILD §11 trends).
