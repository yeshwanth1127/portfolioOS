# Phase 6 exit gate — Targets & measurement ledger

Spec: [BUILD.md §10](./BUILD.md#10-phase-6--targets--measurement-ledger) · Roadmap: [ROADMAP.md § Phase 6](./ROADMAP.md#phase-6--targets--measurement-ledger)

**Exit gate (full phase):** one calendar month for Sona closes with ledger results reproducible from cutoff + `calc_version`; reversed approvals create new `period_results` revisions with audit trail.

## Slice 6.0 — Schema

- [x] Migration `019_ledger_engine.sql`: `metrics`, `target_versions`, `reports`, `report_revisions`, `approvals`, `ledger_entries`, `ledger_source_claims`, `period_results`, `idempotency_keys`; `aggregation` enum; task/milestone contribution columns.
- [x] Insert-only triggers + `REVOKE UPDATE, DELETE` on immutable ledger tables (matches audit/activity pattern).
- [x] Verify `packages/db/migrations/verify/019_ledger_engine.sql`.
- [x] Workspace RLS on all ledger tables.

## Slice 6.1 — Domain & atomic ops

- [x] Approve report revision → `approvals` + `ledger_entries` + source claims + `ledger_recompute` job.
- [x] Reverse approval → revoking approval + offsetting entry + claim release.
- [x] Correction path via `report_revisions.supersedes` (reverse prior approved entry on approve).
- [x] Duplicate `source_task_id` rejected at submission when claim exists.
- [x] Permissions: `target.edit`, `report.approve` in `docs/permissions.csv` + `matrix.js` (`report.approve` maps to submission review gate in `can()`).

## Slice 6.2 — Period results

- [x] `computePeriodResult` with `calc_version = ledger-v1`, `inputs_hash`, sum/average/latest/ratio aggregations.
- [x] New `period_results` revision on input change (no updates).
- [x] Active entries = non-reversed primaries (`reverses IS NULL` and not reversed).
- [x] Tests: reproduction hash stability; aggregation + status bands.

## Slice 6.3 — HTTP + agent

- [x] Routes: `GET/POST /metrics`, `POST /metrics/:id/targets`, `POST /reports/revisions`, approve/reject/reverse, `GET /metrics/:id/period-results`.
- [x] Agent: `list_metrics`, `record_report`, `approve_report` (+ catalogue schemas).
- [x] Legacy KPI/submission HTTP unchanged; pre-cutoff reads may return `provenance: legacy_scoring`.

## Slice 6.4 — Cutoff migration (local)

- [x] `LEDGER_CUTOFF_DATE` + `packages/api/src/core/ledger-config.js` (test default `2099-01-01`).
- [x] `scripts/ledger-migrate-kpis.js` — active KPIs → metrics + `target_versions` at cutoff.
- [ ] Full `legacy.*` schema move deferred (BUILD §10.5 prod step).

## Slice 6.5 — Web

- [x] `/goals` Goals & Metrics list; sidebar link.
- [x] Overview **Target attainment** card (`target_attainment` on overview payload).

## Slice 6.6 — Tests

- [x] `tests/integration/ledger-engine.test.js` — approve, reverse, hash, duplicate task claim.
- [x] `tests/integration/period-results.test.js` — aggregation math, status bands.
- [x] Permission matrix extended for new actions.

## Phase 6 gate-ready (local)

| Check | Command / artefact |
|-------|-------------------|
| Migrations through `019` | `tests/integration/migrations.test.js` |
| Ledger engine | `tests/integration/ledger-engine.test.js` |
| Period results | `tests/integration/period-results.test.js` |
| Full suite | `npm test` (see [PHASE7_EXIT.md](./PHASE7_EXIT.md) for current count) |
| Web build | `npm run build -w @portfolio-os/web` |

## Migrations added

| Migration | Purpose |
|-----------|---------|
| `019_ledger_engine.sql` | Ledger schema, RLS, immutability, contribution columns |

## Production-only (not required for local gate)

- [ ] Sona month-close rehearsal on live DB with reconciliation vs legacy scores.
- [ ] Declare production `LEDGER_CUTOFF_DATE` and run `scripts/ledger-migrate-kpis.js` under change control.
- [ ] Optional carry-forward of open-period legacy submissions (BUILD §10.5 §5).
- [ ] Move MVP tables to `legacy` schema with read-only grants.

## Known limitations (local gate)

- Idempotency keys table exists; HTTP replay wrapper not wired on all mutations.
- Task/milestone contribution approve API stubbed in schema only (report path fully wired).
- Pre-cutoff UI still leans on legacy `scores` for Performance card; ledger `provenance` flag on period-results only.
- `inputs_hash` identifies entry ids at cutoff; calc code changes require bumping `calc_version`.
