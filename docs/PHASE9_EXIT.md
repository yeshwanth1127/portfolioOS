# Phase 9 exit gate — Expansion

Spec: [BUILD.md](./BUILD.md) · Roadmap: [ROADMAP.md § Phase 9](./ROADMAP.md#phase-9--expansion)

**Production exit gate:** live Google/Outlook OAuth, Stripe live mode, attachment CDN, full workload capacity modelling (deferred here).

**Local gate (this document):** schema, APIs, web timeline/saved views, integration tests — same standard as Phases 4–8.

## Slice 9.0 — Schema `021_expansion.sql`

- [x] `task_dependencies` (+ cycle trigger), `project_templates`, `attachments`, `saved_views`, `calendar_integrations`, `calendar_sync_log`, `billing_customers`
- [x] `tasks.estimate_hours`
- [x] RLS on all; default template + `billing_customers` row on workspace insert; pilot plan features `billing`, `calendar_sync`

## Slice 9.1 — Task dependencies API

- [x] `POST/DELETE /tasks/:id/dependencies`
- [x] `GET /projects/:id/dependency-graph` (nodes + `blocked_by`, edges)
- [x] Cycle → **409** with clear message

## Slice 9.2 — Templates

- [x] `GET/POST /project-templates`, `POST /projects/from-template/:id`
- [x] Seeded **Standard delivery** template per workspace

## Slice 9.3 — Attachments

- [x] `POST /attachments` (JSON + `storage_key` / `content`; local `ATTACHMENTS_DIR`)
- [x] `GET /attachments/:id` download (`content_base64`)

## Slice 9.4 — Saved views & workload

- [x] `GET/POST /saved-views`, `DELETE /saved-views/:id`
- [x] `GET /workload?unit_id=`
- [x] Web: saved views list on `/projects`

## Slice 9.5 — Web timeline

- [x] `/projects/[id]/timeline` — week strip for tasks/milestones with due dates
- [x] Link from project detail header

## Slice 9.6 — Calendar sync (stub)

- [x] `POST /integrations/calendar/connect`, `GET /integrations/calendar/status`, `POST /integrations/calendar/sync`
- [x] Job `calendar_sync_pull` (no-op + `calendar_sync_log` row)
- [x] Agent read tool `connect_calendar` on catalogue

## Slice 9.7 — Self-service billing (stub)

- [x] `POST /billing/checkout-session` (mock when `STRIPE_SECRET_KEY` unset)
- [x] `POST /billing/webhook` → `billing_customers` + `auth.set_workspace_entitlement`
- [x] `feature.billing` gate on checkout

## Slice 9.8 — Tests & docs

- [x] `tests/integration/expansion.test.js`
- [x] `npm test` green; `npm run build -w @portfolio-os/web`
- [x] [ROADMAP.md](./ROADMAP.md) Phase 9 gate-ready (local); Phases **0–9** local gates complete

## Phase 9 gate-ready (local)

| Check | Command / artefact |
|-------|-------------------|
| Expansion slice | `tests/integration/expansion.test.js` |
| Migrations | `021_expansion.sql` |
| Full suite | `npm test` (**139** tests) |
| Web build | `npm run build -w @portfolio-os/web` |

## Production deferrals

- [ ] Live **Google/Outlook OAuth** token exchange and two-way sync
- [ ] **Stripe** hosted checkout + signed webhooks in production
- [ ] Attachment CDN / virus scan / size quotas
- [ ] Cross-project dependencies and critical-path scheduling
- [ ] Team capacity calendars (PTO, allocations)

## Files added / changed (main)

| Area | Path |
|------|------|
| Migration | `packages/db/migrations/021_expansion.sql` |
| Expansion | `packages/api/src/modules/expansion.js`, `billing.js` |
| Routes | `packages/api/src/routes.js` |
| Agent | `packages/api/src/agent-tools.js` |
| Web | `apps/web/app/projects/[id]/timeline/page.js`, `projects/page.js`, `projects/[id]/page.js` |
| Docs | `docs/PHASE9_EXIT.md`, `docs/ROADMAP.md`, `docs/agent-tools.md` |
| Tests | `tests/integration/expansion.test.js` |
