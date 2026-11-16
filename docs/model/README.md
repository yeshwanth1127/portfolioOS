# PortfolioOS — entity & permission model (Phase 1)

**Revision:** draft for engineering review · 12 Nov 2026  
**Audience:** Sona, engineering, second pilot customer

These documents describe **what exists in code and schema today**, plus **what later phases add** without pretending unbuilt behaviour is live. They are Phase 1 definition artefacts ([BUILD.md § 5](../BUILD.md#5-phase-1--definition-artefacts), [ROADMAP.md § 3](../ROADMAP.md#3-phase-overview)).

## Contents

| File | Purpose |
|------|---------|
| [entities.md](./entities.md) | Tables and relationships: workspace boundary, organisations, people, reporting, calendar, jobs; contrast with Phase 3+ `units` / `assignments`. |
| [../phase3-people-units.md](../phase3-people-units.md) | Phase 3 prep: schema delta, migration strategy, API/modules, tests, exit gate (engineering; not applied yet). |
| [permissions-matrix.md](./permissions-matrix.md) | Phase 0 `role_level` × scope × action; mapped to HTTP routes and `POST /agent/tools/portfolio_os`. Cells marked **Phase 4 `can()`** are not centralized yet. |
| [states-submissions.md](./states-submissions.md) | Submission, period lock, approve/reject, lock day, reopen — as implemented ([BUILD.md § 4.4–4.5](../BUILD.md#44-f4-period-lock), [§ 4.6](../BUILD.md#46-f6-approval-checks)). |

## How this relates to BUILD.md

| BUILD section | These docs |
|---------------|------------|
| [§ 1.2 Data model](../BUILD.md#12-data-model) | Baseline table list; **entities.md** adds migrations `007`–`011` (workspaces, `org_periods`, jobs, calendar). |
| [§ 4 Phase 0](../BUILD.md#4-phase-0--foundation-hardening) | Permissions and submission states reflect F4–F6 implementation in `packages/api`. |
| [§ 6 Phase 2](../BUILD.md#6-phase-2--workspaces--app-shell) | Workspace, jobs, calendar — **implemented** (migrations `010`, `011`; modules under `packages/api/src/modules/`). |
| [§ 7 Phase 3](../BUILD.md#7-phase-3--people--units) | `units`, `assignments`, invitations — **planned**; **entities.md** calls out current `organisations` + `memberships`. |
| [§ 8 Phase 4](../BUILD.md#8-phase-4--scoped-permissions) | Future `core/permissions/can()` — **permissions-matrix.md** labels cells not yet driven by `can()`. |
| [§ 10 Phase 6](../BUILD.md#10-phase-6--targets--measurement-ledger) | Targets ledger, `reports`, `metrics` — **not in schema**; MVP still uses `kpis`, `submissions`, `scores`. |
| [§ 11 Phase 7](../BUILD.md#11-phase-7--dashboards--analytics) | Analytics reconciliation rules; today **Overview v1** ([BUILD § 6.7](../BUILD.md#67-overview-v1-api)) is the live dashboard surface. |

## Related artefacts (not in this folder yet)

BUILD § 5 also lists `permissions.csv`, `states.md` (other domains), `targets.md`, and `migration-cutoff.md`. Phase 1 may add those in follow-up PRs; this folder holds the multitask-worker slice requested for workspace / permissions / submissions.

## Source of truth in the repo

| Concern | Location |
|---------|----------|
| DDL | `packages/db/migrations/` (`001`–`011` + `verify/`) |
| Submission / lock behaviour | `packages/api/src/domain/submissions.js`, `signoffs.js`, `core/locks.js` |
| Role helpers | `packages/api/src/roles.js` |
| Agent action gates | `packages/api/src/agent-tools.js` (`actionAllowed`, catalogue) |
| HTTP routes | `packages/api/src/routes.js` |
| RLS | `packages/db/migrations/002_rls.sql`, `009_enforce_rls.sql`, `010_workspaces.sql`, `011_jobs_calendar.sql` |

When code and these docs disagree, **code wins** until the docs are updated in the same change as the behaviour.

## Product review queue (needs Sona sign-off)

Use this list for a short review session with Sona / the second pilot — not blockers for Phase 2 API work, but inputs for freezing Phase 1.

| # | Topic | Doc detail |
|---|--------|------------|
| 1 | Team-lead approval scope | Submitter’s reporting subtree in code vs BUILD “KPI owner” wording — [permissions-matrix.md](./permissions-matrix.md) |
| 2 | Who may record a number | Managers/leads recording without owning the KPI — [permissions-matrix.md](./permissions-matrix.md) |
| 3 | Lock / reopen | vice_manager cannot lock or reopen (matches BUILD “owner/manager”) — confirm intent |
| 4 | Calendar edit rules | Team lead create vs edit/delete — [permissions-matrix.md](./permissions-matrix.md) |
| 5 | Readiness | HTTP owner-only vs agent tool for all roles |
| 6 | Self-approval | Owner and manager may approve own submissions — confirm |
| 7 | Reopen audit | `org_periods.reopen_*` only; no `audit_log` row yet — [states-submissions.md](./states-submissions.md) |
| 8 | Phase 4 prep | Export matrix to `permissions.csv`; central `can()` — [permissions-matrix.md](./permissions-matrix.md) |
