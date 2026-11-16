# PortfolioOS — Build Specification

**Revision 2** · 12 Nov 2026 · engineering spec for review
**Companion:** [ROADMAP.md](./ROADMAP.md) — phases, gates and scope. Step IDs (F1…F15, Phase 2…) match the roadmap. Revision 2 resolves the engineering review of revision 1 (mapping in ROADMAP § 7) and adds the design system (§ 14). Phase 1 as-built model: [docs/model/](./model/README.md).

Hard rule: **Portfolio tools, permissions and playbook live in this repository.** ADK (`qlix-monorepo/adk_new`) is a generic runtime that discovers tools from `GET /agent/tools/catalog` ([AGENTS.md](../AGENTS.md)).

Verification status: written from source at `b549b2b` and the running local database. **Not yet verified:** the production server's database role and port exposure, the external ADK checkout's current callers, and every SQL sketch below (sketches are normative in intent; exact DDL is finalised in the migration PR with tests).

---

## 1. Current state (baseline `b549b2b`)

### 1.1 Services

| Service | Path | Port | Notes |
|---------|------|------|-------|
| API | `packages/api` (Express 4, `pg`, `jsonwebtoken`) | 4001 | `routes.js` (477 lines), `domain/*`, `agent-tools.js` |
| Web | `apps/web` (Next.js 14, React 18) | 3001 | One client component `app/page.js` (2,533 lines, 47 `useState`), `globals.css` |
| Agent runner | `services/agent-runner` | 3940 | Mints run token, starts `run_portfolio_agent.py` per turn → ADK `run_portfolio_turn` |
| WA gateway | `services/wa-gateway` | 3938 | `POST /inbound` (unauthenticated), `POST /api/v1/whatsapp/inbound` (service secret), `wa_outbox` delivery, single `WA_CONNECTOR_ID` |
| WhatsApp sidecar | `qlix-monorepo/platform/qlix-whatsapp-service` | 3939 | Baileys; auth state on the filesystem (`WHATSAPP_AUTH_DIR`), encrypted with `WHATSAPP_AUTH_ENCRYPTION_KEY` |
| Qlix backend-adk | `qlix-monorepo/backend-adk` | 4000 | Inference proxy (gpt-4o-mini) |
| Database | Postgres 16 | 5433 | Migrations `001–006`, runner `packages/db/scripts/migrate.js` |

Production: one container under supervisord (`docker/supervisord.conf`), deployed by `scripts/server-setup.sh`; `docker/entrypoint.sh` migrates, seeds and resets demo passwords.

### 1.2 Data model

23 tables. Core: `organisations` (global unique `slug`), `users` (global unique email, phone), `memberships` (one `org_id`, one `role_level`, `parent_id`), `kpis`, `kpi_goals`, `submissions` (unique `kpi_id, period_date, level`), `signoffs` (unique `org_id, period_date`), `scores` (unique `kpi_id, period_date, how_often`), `amendments` (0 rows; never written), `kpi_audit` (145 rows; goal edits via `kpi_goals` are not audited), `escalations`, `activity_entries`. Agent/WA: `agent_sessions`, `agent_tool_calls`, `agent_pending_confirms`, `wa_auth_state`, `wa_outbox`. Profile: `profile_sections`, `case_studies`, `partnerships`, `org_links`, `revenue_lines`.

Data facts relevant to migration (local DB): submissions 179 locked / 7 validated / 8 submitted / 1 rejected / 0 amended; 1 KPI-day has submissions at two levels; 3 KPIs use `average` roll-up.

### 1.3 Behaviour that later phases must preserve or deliberately change

- **Scoring** (`scoring.js`): at lock time, for each KPI and cadence, takes the **highest-level** accepted submission per day (`DISTINCT ON (period_date) … ORDER BY level DESC`), rolls up by `rollup_method` (sum / average / latest / manual), paces the goal across the period, and upserts `scores`. Accepted states today: `validated`, `locked`, `amended`.
- **Goals**: `kpi_goals (kpi_id, how_often)` with no version history; `kpis.target` mirrors the base cadence.
- **Agent**: catalogue and playbook served by the API; runner pins relative dates, cleans replies, formats tags per channel, guards unbacked claims.

---

## 2. Target architecture

```
apps/web (Next.js App Router · Tailwind · shadcn/ui · Recharts)
  /overview /my-work /orgs /projects /goals /calendar /people /reports /settings
        │ HTTPS JSON
packages/api
  http/ ─┐
  agent/ ┼─► core/context (actor, workspace) ─► core/permissions.can() ─► modules/*/service
  wa/   ─┤                                                                   │
  jobs/ ─┘                                                                   ▼
  core/db.withScope(ctx, fn): short transaction · set_config(app.workspace_id, app.actor_id …)
        │ role portfolio_app (NOSUPERUSER, NOBYPASSRLS) · FORCE RLS · composite workspace FKs
PostgreSQL 16  (schemas: public, auth [definer lookups], legacy [archived MVP tables])
services/agent-runner ─► ADK generic catalogue client ─► /agent/tools/catalog · /agent/tools/portfolio_os
services/wa-gateway  ─► authenticated inbound only ─► workspace connection ─► verified sender ─► runner
```

Principles: one code path for HTTP, agent, WhatsApp and jobs; two enforcement layers (`can()` + database: RLS **and** composite foreign keys); services throw `DomainError`, adapters translate; transactions are short and never span external calls.

### 2.1 Repository layout (target)

```
packages/api/src/
  index.js
  core/ config.js db.js dates.js errors.js passwords.js auth.js audit.js locks.js
        permissions/{actions.js, matrix.js, can.js}
  modules/ workspaces units people projects tasks calendar targets ledger reporting
           dashboards notifications whatsapp billing search
     └─ each: routes.js · service.js · queries.js · tools.js
  agent/ catalog.js dispatch.js playbook.js
  jobs/  queue.js worker.js digest.js reminders.js notifications.js
packages/db/
  migrations/NNN_name.sql (+ optional NNN_name.verify.sql)
  scripts/migrate.js · bootstrap-roles.sql · reconcile/*.sql
apps/web/
  app/(auth)/login · app/(app)/layout.js + routes above · app/(app)/legacy (old page.js until retired)
  components/ui (shadcn) · components/app (Sidebar, SearchBar, StatCard, ListRow, DetailPanel,
  MonthCalendar, Timeline, StatusChip) · components/charts · lib/{api.js, session.js, dates.js}
tests/ integration/ · concurrency/ · agent-eval/ · e2e/ (Playwright, from Phase 5)
```

Files move into modules in the phase that touches them, not as a separate refactor.

---

## 3. Conventions

| Topic | Rule |
|-------|------|
| Transactions | `withScope(ctx, fn)` wraps **database work only**. Never hold a transaction across an agent turn, WhatsApp send or other network call. Bare `query()` is not exported. |
| Errors | Services throw `DomainError(code)` (`forbidden`, `not_found`, `invalid`, `conflict`, `locked`); any throw rolls back. Returning `{ error }` is removed after F3's interim fix. |
| Workspace keys | Every workspace-scoped table has `workspace_id NOT NULL` and `UNIQUE (workspace_id, id)`. **Every reference to another workspace-scoped row is a composite FK** `(workspace_id, x_id) REFERENCES t (workspace_id, id)`. |
| Polymorphism | No `(entity_type, entity_id)` pairs for enforced relationships. Use typed nullable FK columns (each composite) plus a `CHECK (num_nonnulls(a, b, c) = 1)`. |
| Immutability | Approved report revisions, approvals, ledger entries and result revisions are insert-only: the app role has no `UPDATE`/`DELETE` on them, and a trigger rejects updates as a second guard. |
| Dates | Business dates are `date` in the workspace timezone; "today" only from `dates.todayIn(tz)` (server) or `lib/dates.today(tz)` (web). Instants are `timestamptz`. |
| Concurrency | State changes that depend on a period or parent take the documented row lock first (`core/locks.js`), then read state, then write. |
| Audit | Permission, structure, target, approval, ledger, lock/reopen changes write `audit_log` in the same transaction. |
| Migrations | Forward-only, one transaction each, never auto-skipped. Data migrations ship a reconciliation script. |
| API | JSON; errors `{ error: { code, message } }`; 400/401/403/404/409/423; cursor pagination. |
| Agent tools | Declare `action`, `summary`, `mutating`, `input_schema`, `requires` (permission action). |
| Tests | Each gate criterion is an automated test; each bug fix lands with a failing-first test. |

---

## 4. Phase 0 — Foundation hardening

### 4.1 F1 Test harness and CI
- `node --test` suites under `tests/`. `tests/setup.js` starts a Postgres 16 container on a random port, runs `bootstrap-roles.sql` as superuser, migrations as `portfolio_migrator`, and a fixture seed (2 organisations; owner, manager, team lead and two members each).
- Helpers: in-process Express app; `asUser(m)` HTTP client; `db.asApp()`; `twoConnections()` for interleaving transactions with explicit `BEGIN`/barriers.
- `.github/workflows/ci.yml`: Node 20, Docker, `npm ci && npm test`.

### 4.2 F2 Migration runner
- Remove the `42710/42P07/already exists → mark applied` fallback. Any error rolls back and exits non-zero; the migration stays unapplied.
- Add `node migrate.js --baseline <last_id>` for adopting an existing database: for each migration up to `<last_id>` it runs `NNN.verify.sql` (a query returning `true` only if that migration's objects exist with the expected shape) and records it only if verification passes; otherwise it stops and lists what failed. Verify files are written for 001–006.
- Tests: a migration that conflicts halfway fails and is not recorded; baseline refuses a database missing an object from 004.

### 4.3 F3 Rollback on returned errors
- Interim: `withSession` rolls back when the callback returns an object with `error`. Then convert services to throw `DomainError` module by module.

### 4.4 F4 Period lock
New migration: one row per organisation-day that every reporting operation locks.
```sql
CREATE TABLE org_periods (
  org_id uuid NOT NULL REFERENCES organisations(id),
  period_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_by uuid REFERENCES memberships(id), locked_at timestamptz,
  reopened_by uuid REFERENCES memberships(id), reopened_at timestamptz, reopen_reason text,
  PRIMARY KEY (org_id, period_date)
);
INSERT INTO org_periods (org_id, period_date, status, locked_by, locked_at)
SELECT org_id, period_date, 'locked', manager_id, locked_at FROM signoffs;
```
`core/locks.js`:
```js
export async function lockPeriod(client, orgId, date) {
  await client.query(`INSERT INTO org_periods (org_id, period_date) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [orgId, date]);
  const { rows } = await client.query(`SELECT status FROM org_periods WHERE org_id=$1 AND period_date=$2 FOR UPDATE`, [orgId, date]);
  return rows[0].status;  // 'open' | 'locked'
}
```
Called first by `recordNumber`, `amendNumber`, `withdrawSubmission`, `validateSubmission`, `lockDay` and `reopenDay`; each refuses with `locked` unless the operation is `reopenDay`. `lockDay` sets `status='locked'`, writes `signoffs` (kept for compatibility), locks submissions and scores, all under the same row lock.
Tests (`tests/concurrency`): submit-vs-lock and approve-vs-lock interleavings in both orders — the result is either "submission included and then locked" or "submission refused", never a submission created inside a locked day.

### 4.5 F5 Submission state machine

| From | Action | To | Who | Notes |
|------|--------|----|-----|-------|
| — / draft | record | submitted | KPI owner (member), or reviewer roles | period must be open |
| submitted | approve | validated | reviewer in scope, not the submitter | |
| submitted | reject (reason) | rejected | reviewer in scope | |
| rejected | record / correct | submitted | submitter or reviewer | writes `amendments` row if value changed |
| validated | correct (reason) | submitted | submitter or reviewer | clears `validated_by/at`; writes `amendments` row; needs review again |
| submitted / rejected | withdraw | (deleted) | submitter or reviewer | period must be open |
| validated | lock day | locked | owner/manager | via `lockDay` |
| locked | — | — | — | immutable while the day is locked |
| locked day | reopen (reason) | day open; its locked submissions → validated | owner/manager | audited in `org_periods` + `audit_log`; scores for that day are recomputed on the next lock |

- `amended` is no longer assigned; scoring counts only `validated` and `locked` (existing data has 0 `amended` rows).
- `amendments` becomes the correction history (old value, new value, reason, author, time).
- Withdrawing an unapproved number deletes its correction notes with it (`ON DELETE CASCADE`); a durable trail for withdrawals arrives with `audit_log` in Phase 4.
- Recording for a future date is refused.
- **Implemented** in `domain/submissions.js`, `domain/signoffs.js`, migration `007_org_periods.sql`; tests in `tests/integration/submissions.test.js` and `tests/concurrency/period-lock.test.js`.

### 4.6 F6 Approval checks
`validateSubmission` (under the period lock): load the submission `FOR UPDATE`; require state `submitted`; require reviewer authority for that organisation (owner; or manager/vice manager of the same org; or team lead whose reporting subtree contains the KPI owner); refuse self-approval **except for the organisation's manager and the owner**, who have no reviewer above them in that organisation (to be confirmed in the Phase 1 permission matrix); rejecting requires a reason; write reviewer and time.

### 4.7 F7 Dates
- `packages/api/src/core/dates.js`: `todayIn(tz='Asia/Kolkata')` via `Intl.DateTimeFormat('en-CA', { timeZone: tz })`, `addDays`, period windows (moved from `cadence.js`).
- Replace all 16 backend `toISOString().slice(0, 10)` sites, the IST helpers in `agent-tools.js` and `agent-runner`, and the web `todayISO()` in `page.js` (which submits explicit `period_date`s).
- ESLint `no-restricted-syntax` rule for `toISOString().slice(0, 10)`.

### 4.8 F8 Passwords
- `@node-rs/argon2` (argon2id) — or `bcryptjs` if native builds are a problem in the image.
- `verifyPassword`: `$argon2…` → argon2 verify; 64-hex → legacy SHA-256 compare with `timingSafeEqual`, then rehash and update in the same transaction.
- Inventory of SHA-256 writers to change: `packages/api/src/auth.js` `hashPassword`, `packages/db/scripts/seed.js`, `scripts/dev.sh` (demo password sync), `docker/entrypoint.sh` line 51 (demo password reset). Replace the SQL `digest()` updates with a small Node script that writes argon2 hashes.

### 4.9 F9 Secrets
Shared `config` module per service; with `NODE_ENV=production`, missing values, known defaults (`dev-runner-secret`, `dev-portfolio-os-secret-change-in-prod`) or values under 32 characters stop the process. API: `JWT_SECRET`, `AGENT_RUNNER_SECRET`, `DATABASE_URL`. Runner: `AGENT_RUNNER_SECRET`, `QLIX_BACKEND_URL`, `QLIX_AGENT_ID`, `QLIX_RUNNER_TOKEN`. Gateway: `AGENT_RUNNER_SECRET`, `WA_SERVICE_SECRET`, `DATABASE_URL`. `NODE_ENV=production` set for every supervisord program.

### 4.10 F10 WhatsApp identity
Current behaviour (`services/wa-gateway/src/index.js`): `POST /inbound` accepts any `phone_e164` without authentication; `POST /api/v1/whatsapp/inbound` treats every `@lid` sender as the linked phone and, if no phone is found, uses the first active owner.

Required behaviour:
1. `POST /inbound` removed (or service-secret protected and bound to localhost for tests only).
2. All inbound routes require the service secret; the gateway listens on `127.0.0.1` in production.
3. Sender resolution, in order: (a) self-chat — `remote_jid` is one of the linked account's own JIDs (phone JID or its own LID, as reported by the sidecar) → the linked user; (b) contact phone JID → that phone; (c) contact LID → the sidecar's verified LID→phone mapping for that contact; (d) anything else → **rejected**, logged, no agent run, no reply (or a fixed "number not registered" reply without data).
4. Phone → user lookup is restricted to users with an active assignment in the connection's workspace (Phase 2) / an active membership (Phase 0).
5. The owner fallback is deleted.
Tests: unknown phone, unmapped LID contact, LID of another contact, spoofed `phone_e164` without secret — none run as the owner; self-chat still works.

### 4.11 F11 Authentication bootstrap
Pre-scope lookups are the only queries allowed before a scope exists. They live in schema `auth`, owned by `portfolio_migrator`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `EXECUTE` granted to `portfolio_app`, returning minimal columns:
- `auth.login_candidate(email text)` → `user_id, password_hash, status`
- `auth.actor_for_membership(membership_id uuid)` → membership row fields used by `loadMembership` (Phase 2: `auth.actor_for_session(user_id, workspace_id)`)
- `auth.actor_for_phone(connector_id text, phone text)` → user/membership for WhatsApp
- `auth.workspaces_for_user(user_id uuid)` (Phase 2)
`authenticateRequest` and the gateway use these; everything after runs in `withScope`. Run tokens (agent) are verified, then resolved through `auth.actor_for_membership`.

### 4.12 F12 Database roles
`packages/db/scripts/bootstrap-roles.sql`, run once per environment by a superuser (not a numbered migration):
```sql
CREATE ROLE portfolio_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE portfolio_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER DATABASE portfolio_os OWNER TO portfolio_migrator;
REASSIGN OWNED BY portfolio TO portfolio_migrator;          -- existing objects
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- pg_trgm for search (§ 6.8)
GRANT USAGE ON SCHEMA public TO portfolio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portfolio_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO portfolio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO portfolio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO portfolio_app;
```
Env: `DATABASE_URL` (app), `MIGRATION_DATABASE_URL` (migrator). Updated in `docker-compose*.yml`, `.env*.example`, `entrypoint.sh`, `server-setup.sh`. Insert-only tables (later phases) are granted `SELECT, INSERT` only.

### 4.13 F13 Scoped sessions and forced RLS
1. Replace the 16 bare `query()` handlers with `withScope`; split long flows: `/agent/chat` = scope(load session) → release → call runner → scope(save messages).
2. `FORCE ROW LEVEL SECURITY` on `submissions`, `kpis`, `scores`, `activity_entries`, and policies for `org_periods`, `signoffs`, `amendments`, `kpi_goals`, `memberships`, `escalations`, `agent_sessions`, `agent_tool_calls`, `wa_outbox`.
3. Phase 0 policies are org-scoped as today (`app.role`, `app.org_id`); Phase 2 adds the restrictive workspace policy.
Tests: with the app-level check removed in a test build, cross-org reads and writes still fail.

### 4.14 F14 ADK coordination
- With the qlix-monorepo maintainer: inventory what is committed vs untracked (at review time the whole `adk_new/capabilities/shared/portfolio_os/` tree, `portfolio_os_http_client.py`, `portfolio_os_pack.py`, `portfolio_os_playbook.py`, the test and the `capability_scope_index.py` registration were uncommitted), verify callers, and agree a **generic HTTP catalogue client** in ADK that takes the catalogue URL and invoke path as configuration and builds its schema from the catalogue's per-tool `input_schema`.
- Candidates for removal there (to verify with the maintainer, not to delete from this repo's side): hardcoded `_INPUT_PROPERTIES`, action names in `static_scope_index_definition`, `PortfolioOsPack` agent ids, legacy `portfolio_os_runner.py`, the scope-index registration.
- This repo: add `input_schema` per tool to the catalogue; pin `QLIX_MONOREPO_SHA` in `decisions.md`. **Gate:** Portfolio's Phase 0 passes only against a tested, committed ADK revision.

### 4.15 F15 Server checks and backups
- `psql "$DATABASE_URL" -tAc "select rolsuper, rolbypassrls from pg_roles where rolname=current_user"` must print `f|f`.
- Only the web port is public; 4001, 3938, 3939, 3940 and Postgres bound to localhost or the internal network.
- Backups: daily `pg_dump` **and** the WhatsApp auth volume (`portfolio_wa_auth`; locally `.live/wa-auth`); `WHATSAPP_AUTH_ENCRYPTION_KEY` stored in the secret store, not only in `.env`. Restore drill proves the session resumes without re-scanning the QR.

---

## 5. Phase 1 — Definition artefacts

| Artefact | Format | Location |
|----------|--------|----------|
| Entity model | ER diagram + table list with keys | `docs/model/entities.md` |
| Permission matrix | CSV consumed by `core/permissions/matrix.js` and the generated test | `docs/model/permissions.csv` |
| State machines | Tables like § 4.5 for reports, approvals, tasks, projects, ledger, periods | `docs/model/states.md` |
| Target & ledger rules | Spec with worked examples per target type and aggregation | `docs/model/targets.md` |
| Migration cutoff policy | Carried / legacy-provenance / not reconstructed | `docs/model/migration-cutoff.md` |
| Prototype | Next.js routes on the design system with mock data, feature-flagged | `apps/web/app/(proto)` |
| Agent eval set | JSONL `{ message, role, expected_tools[], must_contain[] }` + runner | `tests/agent-eval/` |

---

## 6. Phase 2 — Workspaces + app shell

### 6.1 Schema
```sql
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug text UNIQUE NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata', currency char(3) NOT NULL DEFAULT 'INR',
  plan text NOT NULL DEFAULT 'pilot', status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_role text NOT NULL CHECK (workspace_role IN ('owner','admin','member')),
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connector_id text UNIQUE NOT NULL, linked_phone_e164 text,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id),
  kind text NOT NULL, payload jsonb NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
  locked_by text, locked_at timestamptz, done_at timestamptz, last_error text,
  dedupe_key text UNIQUE
);
```
Per business table: add `workspace_id`, backfill Sona, `SET NOT NULL`, add `UNIQUE (workspace_id, id)`, convert each FK to composite (§ 6.3). `organisations.slug` becomes `UNIQUE (workspace_id, slug)`. `users` stay global; `phone_e164` stays globally unique (it routes WhatsApp).

### 6.2 RLS: restrictive isolation + scoped access
Permissive policies are OR-ed, so isolation must be **restrictive** (AND-ed with every permissive policy):
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON <t> AS RESTRICTIVE
  USING (workspace_id = current_setting('app.workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid);
-- access inside the workspace (org-scoped until Phase 4 replaces it with assignment scope);
-- written per table — tables without org_id (e.g. workspace_members, jobs) get their own access policy
CREATE POLICY ws_access ON <t>
  USING (current_setting('app.workspace_role') IN ('owner','admin')
         OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
```
The Phase 0 policies that grant `app.role = 'owner'` are **dropped** in the same migration. `current_setting('app.workspace_id')` is called without `missing_ok`, so a missing scope raises an error.
Regression tests: owner of workspace A reads, updates and deletes against workspace B rows by id → zero rows / errors; inserting a row with B's `workspace_id` while scoped to A → `WITH CHECK` violation.

### 6.3 Composite foreign keys
Pattern for every child table:
```sql
ALTER TABLE kpis ADD CONSTRAINT kpis_org_fk
  FOREIGN KEY (workspace_id, org_id) REFERENCES organisations (workspace_id, id);
```
FK checks bypass RLS, so this is the only guarantee that a row cannot point into another workspace. Applied to every relationship in the current schema and in all new schemas below. A schema test enumerates `information_schema` and fails if any FK between workspace tables lacks `workspace_id`.

### 6.4 WhatsApp per workspace
Gateway: inbound `connector_id` → `whatsapp_connections` → workspace → `auth.actor_for_phone` within that workspace (§ 4.10 rules). `wa_auth_state` and `wa_outbox` gain `connection_id` (composite FK). Outbound replies always use the originating connection. Settings → WhatsApp manages the workspace's connection (QR link, status, unlink).

### 6.5 Job queue
Worker loop: `SELECT … FROM jobs WHERE done_at IS NULL AND run_at <= now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 10`; each job runs in its own scoped transaction for its workspace; failures back off exponentially; `dedupe_key` makes enqueue idempotent (e.g. `reminder:event:<id>:<at>`). Replaces in-process timers for digest and reminders.

### 6.6 Calendar & events
```sql
CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid, project_id uuid,                     -- composite FKs; project_id added in Phase 5
  title text NOT NULL, kind text NOT NULL DEFAULT 'meeting'
    CHECK (kind IN ('meeting','review','visit','call','deadline','other')),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, all_day boolean NOT NULL DEFAULT false,
  location text, description text,
  reminder_minutes int[] NOT NULL DEFAULT '{30}',
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES organisations (workspace_id, id),
  CHECK (ends_at >= starts_at)
);
CREATE TABLE calendar_event_participants (
  workspace_id uuid NOT NULL, event_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  response text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending','yes','no','maybe')),
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES calendar_events (workspace_id, id) ON DELETE CASCADE
);
```
API (module `calendar`):
- `GET /calendar?from=&to=&scope=` → merged feed: events + derived items (reporting deadlines from KPI cadences, open days awaiting lock; Phase 5 adds milestones and task due dates; Phase 6 target checkpoints). Each item: `{ id, source, title, kind, starts_at, ends_at, all_day, location, participants[], link }`.
- `POST/PATCH/DELETE /calendar/events/:id`, `POST /calendar/events/:id/respond`.
- `GET /calendar.ics?token=` per-user export (signed, revocable token).
- Reminders: creating/updating an event enqueues jobs per `reminder_minutes`; the job sends in-app + WhatsApp via the workspace connection.
- Agent tools: `list_events`, `add_event`, `move_event` (permission `calendar.*`).

### 6.7 Overview v1 API
`GET /dashboards/overview?date=` (owner/admin; managers get their org) returns everything the screen needs in one call:
```json
{
  "greeting": { "name": "Thyagu", "summary": "3 organisations need attention · 5 approvals waiting · 1 event today" },
  "organisations": { "locked": 5, "open": 2, "attention": 3,
                     "bars": [{ "org": "PATS", "good": 6, "watch": 1, "bad": 2 }] },
  "performance":   { "series": [{ "date": "2026-10-30", "good_share": 0.62 }], "avg": 0.64, "min": 0.51, "max": 0.78 },
  "reporting":     { "submitted": 8, "awaiting_review": 7, "missing": 12 },
  "approvals":     { "pending": 5, "escalations": 1, "days_awaiting_lock": 2 },
  "attention":     [{ "type": "kpi", "id": "…", "title": "Drone serviceability", "org": "PATS",
                      "status": "bad", "value": "66.7%", "goal": "90%", "owner": "Anju Raj" }],
  "as_of": "2026-11-11", "coverage": 0.71
}
```
Detail panel: `GET /kpis/:id/summary?date=` (owner, cadences, last 14 values, current state, actions). Built on current tables; replaced by ledger results in Phase 6.

### 6.8 Search
`GET /search?q=&in=orgs,people,projects,goals` — Postgres `ILIKE` + trigram index (`pg_trgm`) on names; results grouped by type; scope chips in the header map to `in`.

### 6.9 Migration and reconciliation
`reconcile/0xx_workspaces.sql`: per-table counts before/after, no null `workspace_id`, checksums on `kpis`, `submissions`, `scores`, `org_periods`. Rehearsal: restore a production dump → migrate → reconcile → full tests → timing recorded.

---

## 7. Phase 3 — People & units

```sql
CREATE TYPE unit_type AS ENUM ('organisation','branch','department','team');
CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  parent_id uuid, type unit_type NOT NULL,
  name text NOT NULL, short_name text, code text, status text NOT NULL DEFAULT 'active',
  legacy_org_id uuid UNIQUE,                         -- plain column, no FK (legacy tables get archived)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES units (workspace_id, id)
);
CREATE UNIQUE INDEX units_sibling_name ON units (workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name));
CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  unit_id uuid, project_id uuid,                     -- exactly one; project_id FK added in Phase 5
  role text NOT NULL,                                -- from the Phase 1 matrix
  reports_to uuid, is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active', starts_on date, ends_on date,
  legacy_membership_id uuid UNIQUE,
  UNIQUE (workspace_id, id),
  CHECK (num_nonnulls(unit_id, project_id) = 1),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, reports_to) REFERENCES assignments (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id)
);
CREATE UNIQUE INDEX one_primary_assignment ON assignments (workspace_id, user_id) WHERE is_primary AND status = 'active';
CREATE TABLE invitations (… workspace_id, email/phone, role, unit_id, token_hash, expires_at, accepted_at, composite FKs …);
```
- Type rules (branch under organisation; department under organisation or branch; team under organisation, branch or department) enforced by a trigger and the service.
- Cross-unit work = additional assignments; the tree defines only primary ownership and reporting.
- Migration: `organisations` → organisation units; `memberships` → assignments (owner → workspace owner, manager → `unit_manager`, vice_manager → `unit_deputy`, team_lead → `team_lead`, member → `contributor`), `parent_id` → `reports_to`; `is_named = false` people → pending invitations. Reads move to `assignments`; `memberships` is then write-frozen.

---

## 8. Phase 4 — Scoped permissions

```js
// core/permissions/can.js
can(actor, action, resource, scope) → { allowed, reason }
// actor    { userId, workspaceId, workspaceRole, assignments[] }
// action   'submission.approve' | 'target.edit' | 'project.edit' | 'task.assign' | 'unit.manage' | 'calendar.edit' | …
// resource { type, id, unitId?, projectId?, ownerId?, submittedBy?, state?, periodStatus? }
// scope    resolved unit/project ancestry of the resource (WITH RECURSIVE over units, cached per request)
```
- Rules from `matrix.js` (generated from `permissions.csv`) plus resource conditions (no self-approval; no edits in locked periods; state preconditions from § 4.5 and Phase 1 state machines).
- Adapters: `requirePermission(action, loadResource)` for HTTP; `tool.requires` for agent tools; WhatsApp intents map to the same actions; jobs use a system actor bound to one workspace.
- RLS gains assignment-scoped permissive policies for contributor visibility where practical (always under the restrictive workspace policy).
- Generated matrix test: every cell via HTTP and via `POST /agent/tools/portfolio_os` → identical outcomes.

---

## 9. Phase 5 — Projects & My Work

```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  unit_id uuid NOT NULL, primary_branch_id uuid,
  name text NOT NULL, description text, manager_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','on_hold','done','cancelled')),
  priority text NOT NULL DEFAULT 'normal', starts_on date, due_on date,
  health_override text, health_reason text, health_set_by uuid, health_set_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, primary_branch_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, manager_id) REFERENCES workspace_members (workspace_id, user_id),
  CHECK ((health_override IS NULL) = (health_reason IS NULL))
);
CREATE TABLE project_units (workspace_id, project_id, unit_id, role, PRIMARY KEY (project_id, unit_id), composite FKs);
CREATE TABLE milestones (id, workspace_id, project_id, name, due_on, owner_id, status, completed_at,
  UNIQUE (workspace_id, id), composite FKs to projects and workspace_members);
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  project_id uuid NOT NULL, milestone_id uuid,
  title text NOT NULL, description text, assignee_id uuid,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','done','cancelled')),
  priority text NOT NULL DEFAULT 'normal', due_on date, position numeric NOT NULL,
  checklist jsonb NOT NULL DEFAULT '[]', created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones (workspace_id, id),
  FOREIGN KEY (workspace_id, assignee_id) REFERENCES workspace_members (workspace_id, user_id)
);
-- a milestone must belong to the task's project: enforced by trigger (or by (workspace_id, project_id, id) key on milestones)
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  project_id uuid, task_id uuid, milestone_id uuid,
  author_id uuid NOT NULL, body text NOT NULL, mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz,
  CHECK (num_nonnulls(project_id, task_id, milestone_id) = 1),
  composite FKs for each of the three + author
);
CREATE TABLE project_updates (…, composite FKs);
CREATE TABLE notifications (id, workspace_id, user_id, kind, task_id, project_id, event_id, body, channel, read_at, sent_at, created_at, composite FKs);
CREATE TABLE activity_log (id bigserial, workspace_id, actor_id, project_id, task_id, kind, payload jsonb, at);  -- insert-only
ALTER TABLE assignments ADD FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id);
ALTER TABLE calendar_events ADD FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id);
```
- Calculated health from overdue milestones/tasks (Phase 6 adds target attainment), shown beside the manager override with reason and time.
- My Work: my open tasks by due date; milestones I own due in 14 days; reports I owe this period; approvals awaiting me; today's events.
- Notifications via the job queue: assigned, mentioned, due tomorrow, overdue — in-app and WhatsApp.
- WhatsApp intents / agent tools: `my_tasks`, `complete_task`, `comment_on_task`, `post_project_update`.
- Calendar feed adds milestones and task due dates. Overview gains the **Delivery** card.
- Web: `/projects`, `/projects/[id]` (Overview · Tasks [list | board] · Milestones · Targets · Activity), `/my-work`, task side panel, quick-add.

---

## 10. Phase 6 — Targets & measurement ledger

### 10.1 Single counting path
**Results are computed only from ledger entries.** Nothing else is summed. Every source of measurement creates entries when — and only when — it is approved:

| Source | Creates | Entry kind |
|--------|---------|------------|
| Approved report revision (manual, web or WhatsApp) | one entry per revision | `quantity` (sum), `observation` (average/latest), or `ratio` (numerator + denominator) |
| Approved task with a declared contribution | one `quantity` entry | `quantity` |
| Approved milestone with a declared contribution | one `quantity` entry | `quantity` |

A report that refers to a task already counted is rejected at submission ("already counted via task …"), via the source-claim table below.

### 10.2 Schema
```sql
CREATE TYPE aggregation AS ENUM ('sum','average','latest','ratio');
CREATE TABLE metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  unit_id uuid, project_id uuid,                                  -- exactly one scope
  code text NOT NULL, name text NOT NULL, unit_label text NOT NULL,
  aggregation aggregation NOT NULL, direction direction NOT NULL,
  owner_id uuid, evidence_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active', legacy_kpi_id uuid UNIQUE,
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, code),
  CHECK (num_nonnulls(unit_id, project_id) = 1), composite FKs
);
CREATE TABLE target_versions (                                     -- insert-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, metric_id uuid NOT NULL,
  cadence how_often NOT NULL,
  goal numeric, range_low numeric, range_high numeric, watch_ratio numeric NOT NULL DEFAULT 0.8,
  progress_method text NOT NULL DEFAULT 'calendar_days' CHECK (progress_method IN ('calendar_days','working_days','checkpoints')),
  checkpoints jsonb, approval_required boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  reason text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), FOREIGN KEY (workspace_id, metric_id) REFERENCES metrics (workspace_id, id),
  UNIQUE (metric_id, cadence, effective_from)
);
-- insert-only: the version in force on date D is the row with the greatest effective_from <= D
-- (no effective_to to update; a target change is a new row from its effective date)
CREATE TABLE reports (                                             -- identity of "metric X for period P by person Y"
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, metric_id uuid NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL, reporter_id uuid NOT NULL,
  UNIQUE (workspace_id, id), UNIQUE (metric_id, period_start, period_end, reporter_id), composite FKs
);
CREATE TABLE report_revisions (                                    -- insert-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, report_id uuid NOT NULL,
  revision int NOT NULL, value numeric, numerator numeric, denominator numeric,
  source_task_id uuid, evidence_url text, note text,
  channel text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  supersedes uuid,                                                  -- previous revision
  UNIQUE (workspace_id, id), UNIQUE (report_id, revision), composite FKs
);
CREATE TABLE approvals (                                           -- insert-only; persisted approval identity
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  report_revision_id uuid, task_id uuid, milestone_id uuid,
  decision text NOT NULL CHECK (decision IN ('approved','rejected','revoked')),
  decided_by uuid NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(), reason text,
  revokes uuid,                                                     -- approval being revoked
  UNIQUE (workspace_id, id),
  CHECK (num_nonnulls(report_revision_id, task_id, milestone_id) = 1),
  UNIQUE (revokes), composite FKs
);
CREATE TABLE ledger_entries (                                      -- insert-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, metric_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quantity','observation','ratio')),
  quantity numeric, numerator numeric, denominator numeric,
  effective_on date NOT NULL,
  approval_id uuid NOT NULL,                                        -- the approval that created it
  reverses uuid,                                                    -- entry being reversed
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (approval_id),                                             -- exactly one entry per approval (a reversal's approval is the revoking one)
  UNIQUE (reverses),                                                -- at most one reversal per entry (NULLs do not collide)
  composite FKs (metric, approval, reverses)
);
CREATE TABLE ledger_source_claims (                                -- mutable: the one active claim per source
  workspace_id uuid NOT NULL, source_task_id uuid, source_milestone_id uuid, source_report_id uuid,
  entry_id uuid NOT NULL,
  CHECK (num_nonnulls(source_task_id, source_milestone_id, source_report_id) = 1),
  UNIQUE (source_task_id), UNIQUE (source_milestone_id), UNIQUE (source_report_id), composite FKs
);
CREATE TABLE period_results (                                      -- insert-only, revisioned
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
  metric_id uuid NOT NULL, target_version_id uuid NOT NULL, cadence how_often NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL, as_of date NOT NULL,
  revision int NOT NULL, input_cutoff timestamptz NOT NULL, calc_version text NOT NULL,
  actual numeric, expected numeric,
  status text NOT NULL CHECK (status IN ('good','watch','bad','unscored','missing','overdue')),
  coverage numeric, inputs_hash text NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (metric_id, cadence, period_start, as_of, revision), composite FKs
);
ALTER TABLE tasks ADD COLUMN contributes_metric_id uuid, ADD COLUMN contributes_quantity numeric,
  ADD FOREIGN KEY (workspace_id, contributes_metric_id) REFERENCES metrics (workspace_id, id);
ALTER TABLE milestones ADD COLUMN contributes_metric_id uuid, ADD COLUMN contributes_quantity numeric, ADD FOREIGN KEY (…);
```
Grants: `SELECT, INSERT` only on `target_versions`, `report_revisions`, `approvals`, `ledger_entries`, `period_results`, `activity_log`, `audit_log`; triggers reject `UPDATE`/`DELETE` as a second guard.

### 10.3 Atomic operations (each one transaction, under the metric-period lock)
- **Approve a report revision:** lock `(metric_id, period)`; require latest revision and state *submitted*; insert `approvals`; insert `ledger_entries(approval_id)`; upsert `ledger_source_claims(source_report_id → entry)` (and `source_task_id` if the revision names a task — the unique key rejects a task already counted); enqueue result recomputation.
- **Approve task/milestone contribution:** lock the task row and metric-period; insert approval; insert entry; insert claim (unique key prevents double counting on retry — a retry finds the existing approval/claim and returns it).
- **Reverse:** insert `approvals(decision='revoked', revokes=…)`; insert `ledger_entries(reverses=orig, quantity = -orig.quantity …, approval_id = revoking approval)` — `UNIQUE (reverses)` allows exactly one; delete the source claim so the source can be re-approved later as a new entry.
- **Correct after approval:** insert a new `report_revisions` row (`supersedes` = approved revision) → it is *submitted*; on its approval the old entry is reversed and a new entry created, in one transaction.
- **Idempotency:** each API mutation accepts an `Idempotency-Key`; stored in `idempotency_keys (workspace_id, key, response, created_at)`; replays return the stored response.

### 10.4 Results
- `actual` from active entries for the metric and period with `recorded_at <= input_cutoff`: `sum` → Σ quantity; `average` → mean of observations; `latest` → observation with the greatest `effective_on` then `recorded_at`; `ratio` → Σ numerator / Σ denominator.
- `expected` from the target version in force on `as_of`: goal × elapsed/total (calendar or workspace working days) or the checkpoint value.
- Status bands: higher-is-better good ≥ expected, watch ≥ `watch_ratio` × expected; lower-is-better mirrored; range targets good inside `[range_low, range_high]`; `missing` when expected reports are absent past their deadline; `overdue` past period end without close.
- `inputs_hash` = SHA-256 over (target_version_id, calc_version, sorted active entry ids). Entries are immutable, so the hash identifies the exact inputs.
- **Reproduce** an old result = recompute with its `input_cutoff` and `calc_version` → identical `inputs_hash`, `actual`, `status`. **Recalculate** after a correction = new `input_cutoff` → new `revision`; earlier revisions remain and are labelled superseded.
- Changing calculation code bumps `calc_version`; old results keep the old version label.

### 10.5 Migration from the MVP (cutoff-based)
1. **Cutoff date C** chosen in Phase 1 policy (e.g. the first day of the month after Phase 6 deploys). The new engine is authoritative from C.
2. **Legacy history is not reconstructed.** `kpis`, `kpi_goals`, `kpi_audit`, `submissions`, `amendments`, `signoffs`, `org_periods`, `scores`, `memberships` move to schema `legacy` (read-only grants) and are kept; Goals screens show pre-C periods from `legacy.scores` labelled *"legacy scoring — target history incomplete"*. `legacy_*_id` columns are plain uuids (no FK) so archiving never breaks constraints.
3. **Metrics**: each active KPI → metric; aggregation carried exactly (`sum`→sum, `average`→average, `latest`→latest, `manual`→ flagged for owner review before C).
4. **Targets**: the goal in force at C becomes version 1 (`effective_from = C`, reason "migrated from MVP"); earlier `kpi_audit` rows are linked for reference only.
5. **Optional carry-forward of the open period**: if C falls mid-period, approved legacy submissions inside that period are migrated as report revisions + approvals + entries using the legacy **selection rule** (highest-level accepted submission per day) so period-to-date figures match; a reconciliation script compares the new result with `legacy.scores` for the same day and must match within rounding before C is declared.

---

## 11. Phase 7 — Dashboards & analytics

- Endpoints `/dashboards/{owner,unit/:id,project/:id,me}` return figures with `as_of`, `coverage`, and drill-down query ids; owner extends the Phase 2 `overview` payload (Delivery and Target attainment cards from Phases 5–6).
- Measures kept separate: task completion, target attainment (from `period_results`, current revision), on-time delivery, reporting completeness.
- Materialised rollups only if live queries exceed 300 ms p95 on pilot data.
- Reconciliation tests: each figure equals an independent SQL query over source tables.
- Digest job (05:30 workspace time) reuses the owner dashboard service.

---

## 12. Phase 8 — Commercial pilot

| Item | Build |
|------|-------|
| Onboarding | Setup wizard; CSV import with dry-run; templates; seeded demo workspace |
| Entitlements | `plans`, `workspace_entitlements`; `feature.*` actions in `can()` |
| Usage | Active users, WhatsApp messages, agent turns per workspace |
| Ops | Error monitoring, structured logs with request ids, rollback by tagged image |
| Backups | Daily `pg_dump` + WhatsApp auth volume; encryption key in the secret store; monthly restore drill including WhatsApp session resume |
| Portability | Workspace export (CSV/JSON zip); deletion job with grace period |
| Security | Rate limits on login, agent and WhatsApp; session revocation; audit log viewer |

---

## 13. Agent integration (all phases)

- Catalogue entries: `action`, `label`, `summary`, `mutating`, `input_schema`, `requires`, `allowed` (for the caller). Playbook and reply format in `agent/playbook.js`.
- Dispatch: run token → `auth.actor_for_*` → `can()` → module service in `withScope`. Tool responses are compact and explicit (names, dates, precomputed counts).
- Runner keeps date pinning, reply clean-up, tag formatting per channel, claim guard; no Portfolio actions are added to ADK.
- Model chosen from the Phase 1 evaluation set; nightly eval in CI fails on tool-correctness regressions.

---

## 14. Design system and frontend

### 14.1 Tokens (Tailwind theme; values to be finalised in the Phase 1 prototype)

| Token | Value | Use |
|-------|-------|-----|
| `canvas` | `#F6EFE3` | page background (warm cream) |
| `frame` | `#FBF7F0` | main content frame |
| `ink` | `#141414` | text, black pills, sidebar |
| `muted` | `#6E675C` | secondary text |
| `line` | `#E7DECF` | dividers, inactive chips |
| `row` | `#EFE7D8` | list rows, timeline cards |
| `butter` | `#F2DB78` | summary card 1 |
| `rose` | `#EDB8DA` | summary card 2, selected row, today in calendar |
| `olive` | `#A6AB67` | summary card 3 |
| `periwinkle` | `#AAB6E6` | summary card 4 |
| `good` / `watch` / `bad` | `#1F7A52` / `#9A6200` / `#B42318` (+ tints) | status only — never decorative |
| Radius | frame 28px · cards 18px · rows 14px · pills 999px | |
| Type | Plus Jakarta Sans (next/font): greeting 40/700, card title 20/600, figures 15/700, captions 11/500 uppercase | |

### 14.2 Layout
- `app/(app)/layout.js`: 3-column grid — sidebar (240px, collapsible to 72px) · main (fluid) · right rail (320px; on Overview and Calendar).
- **Sidebar** (black, rounded): logo; *General*: Overview, My Work, Organisations, Projects, Goals & Metrics, Calendar, People, Reports; *Tools*: Agent, WhatsApp, Settings; Log out. Active item marked with a vertical bar and rose text.
- **Header**: round rose search button; search input with scope chips (*In:* Organisations · Projects · People · Goals); round black buttons for profile, notifications (badge), settings.
- **Mobile (<768px)**: bottom tab bar (Overview, My Work, Calendar, Agent, More); right rail stacks below main.

### 14.3 Components (`components/app`)
| Component | Behaviour |
|-----------|-----------|
| `Greeting` | "Good morning/afternoon/evening, {first name}" by workspace time; summary sentence from the overview payload |
| `StatCard` | colour, title, three `{value, unit, caption}` figures, chart slot, decorative SVG shape; click → drill-down |
| `BarMini`, `LineMini`, `CountTrio` | Recharts wrappers styled for cards (line with highlighted point and dashed marker) |
| `ListRow` | icon tile, title, sub-label, time/status chip; selected state uses `rose` |
| `DetailPanel` | header, tag chips, labelled fields, actions; updates with list selection |
| `MonthCalendar` | month grid with ISO week numbers, today highlight, event dots, prev/next, keyboard navigation; clicking a day sets the timeline date |
| `Timeline` | hourly rail for the selected day, event cards (kind icon, title, location, time, participant avatars, +N), dashed **now** line updated every minute, "View all" |
| `EventDialog` | add/edit: title, kind, date, start/end or all-day, location, organisation/project, participants, reminders; validation; optimistic update |
| `StatusChip` | icon + text for good/watch/bad/unscored/missing/overdue |

### 14.4 Screens and migration order
| Phase | Screens (new design) | Replaces in `page.js` |
|-------|----------------------|------------------------|
| 2 | Shell, **Overview v1**, **Calendar** (`/calendar` month + day), Settings (workspace, WhatsApp), Agent panel | Overview, Settings, Agent tab |
| 3 | Organisations, People | Team, parts of Account |
| 5 | Projects, My Work | — (new) |
| 6 | Goals & Metrics | KPIs, Set goals |
| 7 | Reports, role dashboards | remaining tabs; `legacy/` route removed |

Data fetching via `lib/api.js` (typed wrapper, error mapping, idempotency keys on mutations) and `lib/session.js`; React Server Components for read-only views where the session allows; no global state library unless needed. Accessibility: status as text + colour, focus rings, keyboard support for tables, board, calendar and dialogs.

---

## 15. Testing strategy

| Layer | Tool | Covers |
|-------|------|--------|
| Integration | `node:test` + disposable Postgres | gates; permission matrix; state machines; reconciliation |
| Concurrency | two-connection harness | submit/approve vs lock; double approval; reversal races; idempotent retries |
| Isolation | schema + policy tests | restrictive policy present on every table; composite FK audit via `information_schema`; owner-A-vs-workspace-B |
| Identity | gateway tests | unauthenticated inbound refused; unknown/unmapped senders rejected; no owner fallback |
| Migrations | runner tests + rehearsal | failed migration not recorded; baseline verification; dump → migrate → reconcile |
| Agent eval | `tests/agent-eval` | tool choice/arguments, reply format, accuracy |
| E2E | Playwright (Phase 2 shell; full journey from Phase 5) | Overview, calendar add/edit, core journey |
| CI | GitHub Actions | all of the above on PR; Playwright + agent eval nightly |

---

## 16. Deployment

- Two DB URLs (`DATABASE_URL`, `MIGRATION_DATABASE_URL`); `bootstrap-roles.sql` once per environment.
- `NODE_ENV=production` everywhere; startup secret validation.
- Migrations run before the new container serves traffic; reconciliation must pass for data migrations.
- Network: only the web port public; gateway on localhost; Postgres internal.
- Backups and restore per § 4.15 / Phase 8.
- `DEPLOY.md` updated at each gate.

---

## 17. Definition of done (every step)

1. Merged with tests for its acceptance criteria (concurrency tests where state depends on locks).
2. CI green; no bare `query()`; no missing composite FK or restrictive policy on workspace tables.
3. `can()` and audit hooks for every new mutating action; insert-only tables respected.
4. Agent catalogue updated when the capability should be reachable by chat/WhatsApp.
5. ROADMAP, BUILD, agent-tools and DEPLOY docs updated when behaviour or setup changes.
