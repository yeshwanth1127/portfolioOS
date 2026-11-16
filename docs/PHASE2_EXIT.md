# Phase 2 exit checklist (engineering gate — local)

One-page gate before calling Phase 2 **engineering** done locally. Production-only steps are called out in [Remaining (production)](#remaining-production); see also [SONA_MIGRATION.md](./SONA_MIGRATION.md), [PHASE2_TRACKB.md](./PHASE2_TRACKB.md), and [ROADMAP.md](./ROADMAP.md) § Phase 2.

**Exit gate (ROADMAP):** workspace A cannot read B; Sona reconcile passes; Overview v1 + calendar work end to end; a calendar reminder is enqueued and reaches `wa_outbox` via the job queue.

| Check | Done when | Verify |
|-------|-----------|--------|
| **Workspace isolation (A ≠ B)** | RLS, composite FKs, HTTP tokens scoped | `npm test` → `tests/integration/workspaces.test.js` |
| **Sona reconcile (fixture DB)** | Integrity + baseline round-trip on migrated test data | `npm test` → `tests/integration/sona-reconcile.test.js` |
| **Sona reconcile (real / prod DB)** | Row counts + checksums vs pre-010 baseline; Sona slug owns legacy orgs | [Rehearsal](#sona-migration-rehearsal-production) below |
| **Overview v1 (API)** | Greeting, cards, attention scoped to workspace | `npm test` → `tests/integration/calendar.test.js` (overview tests) |
| **Calendar (API)** | CRUD, ICS, RSVP, feed | same file |
| **WhatsApp event reminder (job queue)** | `event_reminder` job → `runDueJobs` → `wa_outbox` | `tests/integration/calendar.test.js` → *create event, reminder job…* |
| **Overview + Calendar (browser)** | Shell login, Overview v1, `/calendar` month view | [Web smoke](#web-smoke-optional) or [Manual UI gate](#manual-ui-gate) |
| **Default test runner** | All integration + concurrency suites green | `npm test` (from repo root; Docker for throwaway Postgres unless `TEST_PG_ADMIN_URL` is set) |
| **Web production build** | Next.js compiles | `npm run build -w @portfolio-os/web` |

## Commands (local)

```bash
# Full automated gate (default Phase 2 API + isolation coverage)
npm test

# Sona reconcile logic only (same assertions as integration test, any DB)
# Uses portfolio_migrator; see docs/SONA_MIGRATION.md
MIGRATION_DATABASE_URL='postgresql://portfolio_migrator:…@localhost:5433/portfolio_os' \
  bash scripts/sona-workspace-reconcile.sh

# Compare against a captured pre-010 baseline on a rehearsed migrate
MIGRATION_DATABASE_URL='postgresql://portfolio_migrator:…@…' \
  bash scripts/sona-workspace-reconcile.sh --baseline /path/to/sona-pre-010.json

# Web build (Track B — Tailwind v4 tokens + shell; see PHASE2_TRACKB.md)
npm run build -w @portfolio-os/web
```

## Sona migration rehearsal (production)

Not replaceable by `npm test` — run once on the server **before** calling Phase 2 fully done in production:

1. Capture baseline immediately before `010_workspaces.sql` (see [SONA_MIGRATION.md](./SONA_MIGRATION.md)).
2. Apply migration; run `bash scripts/sona-workspace-reconcile.sh --baseline …` and default `--expect-sona`.
3. Rehearse rollback per SONA_MIGRATION § rollback (restore dump; do not partially drop `workspace_id`).

Checklist rows in SONA_MIGRATION § *Phase 2 exit gate checklist* map 1:1 to the table above.

## Web smoke (optional)

Requires API on **4001** and web on **3001** (e.g. `npm run db:migrate`, `npm run db:seed`, `npm run api:dev`, `npm run web:dev`).

Install browsers once:

```bash
npx playwright install chromium
```

Run (skips unless `PLAYWRIGHT=1`):

```bash
PLAYWRIGHT=1 \
  PLAYWRIGHT_LOGIN_EMAIL=owner@portfolio.local \
  PLAYWRIGHT_LOGIN_PASSWORD="${DEMO_PASSWORD:-password123}" \
  npm run test:e2e -w @portfolio-os/web
```

Env overrides: `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_LOGIN_EMAIL`, `PLAYWRIGHT_LOGIN_PASSWORD` / `DEMO_PASSWORD`.

## Manual UI gate

If Playwright is not installed or the stack is not running, verify in the browser:

1. Open `http://localhost:3001`, sign in as `owner@portfolio.local` / seeded demo password ([DOCKER.md](./DOCKER.md)).
2. **Overview:** greeting line (`Good …, …`), organisation summary cards, *Needs attention* list loads without error.
3. **Calendar:** sidebar **Calendar** → month grid, **Add event**, **Export** visible; create a personal event and confirm it appears on the grid.
4. **Workspace switcher** (if user has two workspaces): switch workspace; data changes and B data never appears while scoped to A.

API-level reminder + `wa_outbox` behaviour is already covered by integration tests; a **live** WhatsApp delivery check is production-only ([Remaining (production)](#remaining-production)).

## Test map (Phase 2–relevant suites)

| Suite | Phase 2 coverage |
|-------|------------------|
| `workspaces.test.js` | Isolation, composite FKs, HTTP workspace binding, switcher login |
| `sona-reconcile.test.js` | `integrityChecks` + `compareBaseline` on fixture DB |
| `calendar.test.js` | Overview dashboard, calendar API, reminder job → WA outbox |
| `whatsapp.test.js` | Workspace-scoped connections (Phase 2 WA ownership) |
| `isolation.test.js` | Forced RLS (foundation; still required) |

## Remaining (production)

| Item | Why not local |
|------|----------------|
| **F15** server checks | Role, ports, WA volume — `bash scripts/phase0-server-checks.sh` on server ([PHASE0_EXIT.md](./PHASE0_EXIT.md)) |
| **SONA_MIGRATION** reconcile on live data | Needs real pre-010 baseline + `010` on production DB |
| **Live WhatsApp reminder** | Confirm gateway drains `wa_outbox` to a real handset after `runDueJobs` / scheduler on server |
| **F14 ADK** | Generic catalogue client pin — [F14-adk-coordination.md](./F14-adk-coordination.md) |
| **Tailwind + shadcn (Track B design)** | Product polish; not part of the engineering isolation/reconcile gate |

**Local engineering gate:** all `npm test` rows green + web build; optional Playwright or manual UI; document prod rehearsals above before investor/production sign-off.
