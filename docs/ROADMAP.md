# PortfolioOS — Product Roadmap (MVP → sellable platform)

**Revision 2** · 12 Nov 2026 · for engineering review
**Companion:** [BUILD.md](./BUILD.md) (technical build specification) · Constraints: [AGENTS.md](../AGENTS.md), [decisions.md](./decisions.md)
**Revision 2 changes:** incorporates the engineering review of revision 1 (see § 7) and the agreed visual direction (§ 5).

---

## 1. What we are building

PortfolioOS today is a working MVP for one owner (Sona) running seven organisations: a KPI register with day/week/month/quarter goals, daily submissions, validation and day locking, good/watch/bad scoring, a web dashboard, and an agent on web chat and WhatsApp.

The goal is a **sellable platform for owners who run several companies, branches, teams and projects**, where assigned work is visibly connected to business results:

- **Organisation management** — customer workspaces containing organisations, branches, departments and teams, with people assigned across them.
- **Project management** — projects, milestones and tasks, with a daily *My Work* view for contributors.
- **Precise targets** — period-based, versioned targets per organisation, branch, team or project, with approval and an auditable history.
- **Work → results** — approved work records an entry in a measurement ledger, so target progress comes from delivered, approved work through one counting path.
- **A calendar that runs the day** — meetings, reviews, visits, milestone and reporting deadlines in one place, with WhatsApp reminders.
- **Role dashboards** — owner, organisation, branch, project and contributor views with drill-down to source records, in the visual style in § 5.
- **WhatsApp-first reporting** — contributors report and update work without learning software. This is our differentiator and appears in every phase.

## 2. Principles

1. **Access boundaries before features.** Nothing customer-facing ships on a foundation that cannot enforce who sees what — at the application *and* database level, including foreign-key relationships.
2. **Each phase ends at a release gate.** Week counts are planning estimates; a phase is finished when its exit criteria are verified.
3. **One permission rule, every entry point.** HTTP routes, agent tools, WhatsApp and background jobs use the same permission check and the same identity rules.
4. **History stays interpretable.** Approved data is immutable; corrections create revisions; results record the inputs, cutoff and calculation version that produced them.
5. **Portfolio owns its agent tools.** Capabilities are added to the PortfolioOS catalogue; ADK is a generic runtime maintained separately ([AGENTS.md](../AGENTS.md)).
6. **Narrow first release.** The core journey ships well before breadth.

## 3. Phase overview

| # | Phase | Estimate | Gate (summary) |
|---|-------|----------|----------------|
| 0 | Foundation hardening | 2–3 weeks | Security, identity and data-integrity defects fixed and tested; RLS enforced; migrations trustworthy |
| 1 | Product & UX definition *(alongside 0)* | 2–3 weeks | Entity model, permission matrix, state machines, target and ledger rules, and the clickable design agreed with Sona and the second pilot customer |
| 2 | Workspaces + app shell | 3 weeks | Two workspaces fully isolated; new themed shell with **Overview v1, working calendar and events** live on current data |
| 3 | People & units | 2 weeks | Customer-editable structure; one person, many assignments |
| 4 | Scoped permissions | 1–2 weeks | Every entry point uses `can()`; matrix fully tested |
| 5 | Projects & My Work | 3–4 weeks | A pilot team runs a real project in the product, with WhatsApp updates and reminders |
| 6 | Targets & measurement ledger | 3 weeks build **+ one live monthly cycle** | A full calendar month closes with reproducible results |
| 7 | Dashboards & analytics | 2–3 weeks (build overlaps Phase 6's live cycle) | Every displayed number reconciles with source records |
| 8 | Commercial pilot | 3–4 weeks | Sona + one external customer onboarded and using it for four weeks |
| 9 | Expansion | ongoing | Dependencies, templates, workload, calendar/billing stubs (local gate) |

**Critical path:** 0 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Phase 1 runs alongside Phase 0 and must finish before Phase 2. Phase 7 build may start while Phase 6's live month runs, but Phase 7 cannot pass its gate before Phase 6 does.

**Dependency fixes from revision 1:**
- The **durable job queue** (needed for reminders and notifications) moves from Phase 8 to **Phase 2**.
- The **owner dashboard** exists from **Phase 2** (Overview v1 on current data); Phase 6 adds target cards; Phase 7 completes analytics. The Phase 6 journey therefore ends on a real dashboard.
- **ADK cleanup** is a coordinated dependency with the qlix-monorepo maintainer (F14), not a unilateral edit.

**First commercial milestone (end of Phase 6):** create a workspace → add an organisation and branch → invite a team → create a project → assign work → set a measurable target → submit progress → approve it → see the result on the owner dashboard.

---

## Build status (local)

| Phase | Status |
|-------|--------|
| 0 | **Done locally** (F1–F13): **139** automated tests (see `npm test`); RLS + roles. **F15 docs/script:** [PHASE0_EXIT.md](./PHASE0_EXIT.md), hardened `scripts/phase0-server-checks.sh`, [DEPLOY.md](./DEPLOY.md) first-run checklist. **Open:** F14 ADK ([F14-adk-coordination.md](./F14-adk-coordination.md)), **F15 first run on production server** |
| 1 | **Draft:** [docs/model/](./model/README.md). **Started:** [permissions.csv](./permissions.csv). **Open:** Sona sign-off, design prototype |
| 2 | **Gate-ready (local):** [PHASE2_EXIT.md](./PHASE2_EXIT.md). **Track B shipped:** [PHASE2_TRACKB.md](./PHASE2_TRACKB.md) (Tailwind v4 + shell). **Open (prod / §5 polish):** SONA reconcile on live DB, live WA send, shadcn/search/full sidebar |
| 3 | **Gate-ready (local):** [PHASE3_EXIT.md](./PHASE3_EXIT.md) — `012`–`014`, structure + invite + secondary `POST /assignments`, `/people`. **Open (prod):** §8 sign-off, Sona pilot — [phase3-people-units.md](./phase3-people-units.md) |
| 4 | **Done locally:** `audit_log` + permission audit wired; full matrix HTTP+agent parity — [PHASE4_EXIT.md](./PHASE4_EXIT.md) |
| 5 | **Gate-ready (local):** migrations `015`–`018`, projects/tasks/my-work/milestones/comments/activity, agent delivery tools, task WA outbox jobs, `/projects/[id]` — [PHASE5_EXIT.md](./PHASE5_EXIT.md). **Open (prod):** Sona pilot, live WA reminder rehearsal, copy sign-off |
| 6 | **Gate-ready (local):** migration `019`, ledger domain + period results (`ledger-v1`), metrics HTTP/agent, `/goals`, Overview target attainment — [PHASE6_EXIT.md](./PHASE6_EXIT.md). **Open (prod):** Sona month-close, `LEDGER_CUTOFF_DATE`, legacy schema move |
| 7 | **Gate-ready (local):** dashboards service, role HTTP endpoints, reconciliation tests, `/reports` + CSV, digest job wired to owner metrics — [PHASE7_EXIT.md](./PHASE7_EXIT.md). **Open (prod):** p95 rollups at pilot volume, 05:30 cron enqueue |
| 8 | **Gate-ready (local):** migration `020`, entitlements/usage/onboarding/portability, ops middleware, [PHASE8_EXIT.md](./PHASE8_EXIT.md), [SUPPORT_RUNBOOK.md](./SUPPORT_RUNBOOK.md). **Open (prod):** 4-week Sona + customer pilot, Redis rate limits |
| 9 | **Gate-ready (local):** migration `021`, expansion APIs + timeline/saved views, [PHASE9_EXIT.md](./PHASE9_EXIT.md). **Open (prod):** live OAuth, Stripe, attachment CDN. **Phases 0–9 local gates complete.** |

## 4. Phases in detail

### Phase 0 — Foundation hardening (release gate)

**Why:** the MVP has security, identity and data-integrity defects that would fail a customer review and make later work unsafe. All confirmed in source at `b549b2b`:

| # | Defect | Where |
|---|--------|-------|
| 1 | Passwords hashed with SHA-256 and a fixed salt | `packages/api/src/auth.js`; also written by `docker/entrypoint.sh` (line 51) and `scripts/dev.sh` |
| 2 | Secrets fall back to dev defaults | `auth.js`, `routes.js`, `services/agent-runner`, `services/wa-gateway` |
| 3 | Approval ignores organisation, reviewer scope and state | `domain/submissions.js` `validateSubmission` |
| 4 | Recording a value can reopen a locked submission | `recordNumber` upsert |
| 5 | Submission vs day-lock race (no shared lock) | `recordNumber`, `validateSubmission`, `lockDay` |
| 6 | Corrections overwrite values with no audit trail; scoring counts `amended` rows | `amendNumber`; `scoring.js` |
| 7 | A returned `{ error }` still commits | `packages/api/src/db.js` `withSession` |
| 8 | Most handlers bypass scoped sessions (16 bare `query()` vs 4 `withSession`); auth lookup runs outside any scope | `routes.js`, `auth.js` `authenticateRequest` |
| 9 | RLS not effective: app user is the Docker superuser with `BYPASSRLS`, owns the tables, no `FORCE` | verified locally; server unverified |
| 10 | **WhatsApp identity:** unauthenticated `POST /inbound` trusts a supplied phone; signed route maps any `@lid` sender to the linked (owner) phone and falls back to the first owner | `services/wa-gateway/src/index.js` lines 245–300 |
| 11 | Migration runner marks a failed migration as applied when `organisations` exists | `packages/db/scripts/migrate.js` |
| 12 | "Today" computed in UTC (16 backend call sites + frontend `todayISO()` that submits explicit dates) | `packages/api`, `services`, `apps/web/app/page.js` |
| 13 | No regression tests, no CI | — |
| 14 | Production depends on uncommitted ADK code | `docs/DEPLOY.md` step A1 |

**Steps** (small commits, each with tests):

| Step | Work | Done when |
|------|------|-----------|
| F1 | Integration test harness (`node:test`, disposable Postgres, two-connection helpers for concurrency tests) + GitHub Actions CI | `npm test` green from a clean checkout and in CI |
| F2 | Migration runner: remove the broad "already exists" fallback; add an explicit, verified `--baseline` command | Test: a partially conflicting migration fails and stays unapplied |
| F3 | `withSession` rolls back on returned `{ error }` and on throw | Test: write-then-error leaves no rows |
| F4 | **Period lock:** every submission mutation, approval and day lock takes the same organisation-and-period row lock before checking state | Concurrent submit-vs-lock and approve-vs-lock tests: never a submission inside a locked day |
| F5 | **Submission state machine** (BUILD § 4.5): corrections return to *submitted*, clear prior approval, write an `amendments` row; scoring counts only *validated/locked*; closed days change only through an audited *reopen* by owner/manager | Tests for every allowed and refused transition |
| F6 | Approval checks: organisation scope, reviewer authority, state = *submitted*, no self-approval | Cross-org, double-approval, self-approval and member-approval refused |
| F7 | Shared date module (`todayIn(tz)`), default Asia/Kolkata; all 16 backend sites and the frontend `todayISO()` replaced | Test at 00:30 IST returns the IST date; lint rule blocks the old pattern |
| F8 | scrypt passwords (argon2 optional); legacy SHA-256 upgraded on login; seed, `dev.sh` and `docker/entrypoint.sh` stop writing SHA-256 | Legacy login upgrades hash; grep finds no SHA-256 password writes |
| F9 | Startup secret validation in API, agent-runner and wa-gateway | Production start with a default/missing secret exits non-zero |
| F10 | **WhatsApp identity:** authenticate every inbound path; resolve sender only from verified self-chat JIDs or a verified phone/LID mapping; reject unresolved senders; remove the owner fallback | Tests: unknown sender and unmapped LID contact never act as the owner; unauthenticated inbound refused |
| F11 | **Auth bootstrap:** narrow `SECURITY DEFINER` lookups for login, token → actor and phone → actor; no other pre-scope queries | Auth works with RLS forced; no table readable without scope |
| F12 | Database roles: `portfolio_migrator` (owns schema) and `portfolio_app` (no superuser, no `BYPASSRLS`) | App runs as `portfolio_app` everywhere |
| F13 | Every request uses short scoped transactions (reads included), never held across an agent turn; then `FORCE ROW LEVEL SECURITY` | Cross-org reads return nothing at DB level even with an app bug |
| F14 | **ADK coordination:** with the qlix-monorepo maintainer, verify current code and callers, agree the generic catalogue client, get it committed and tested there; Portfolio pins the commit | DEPLOY.md no longer depends on uncommitted code |
| F15 | Server checks: database role, exposure of gateway ports, WhatsApp auth volume and encryption-key backup | Recorded in DEPLOY.md with commands |

**Exit gate:** all steps done; tests cover cross-organisation access, role restrictions, locked periods and races, correction transitions, partial-failure rollback, legacy login upgrade, WhatsApp identity, and migration failure; the server runs with the new roles and enforced RLS.

---

### Phase 1 — Product & UX definition (alongside Phase 0)

**Deliverables:**

1. **Entity model** — workspace, typed unit tree (organisation → branch → department → team) for primary ownership and reporting, plus cross-unit assignments; person identity vs assignment; projects with an accountable organisation, optional primary branch and participating units; calendar events.
2. **Permission matrix** — role × scope × action (workspace owner/admin, organisation manager, branch manager, project manager, team lead, contributor, viewer), including delegation and WhatsApp behaviour.
3. **State machines** — submission/report, approval, correction and reopen, task, project health, contribution and reversal, period close.
4. **Target rules** — cumulative, ratio and snapshot targets; aggregation (sum, average, latest); reporting windows; expected progress (calendar days, working days, checkpoints); tolerance bands; versioning; states *missing / overdue / submitted / approved / rejected / unscored*.
5. **Measurement-ledger rules** — the single counting path (§ BUILD 10): what creates an entry, approval identity, idempotency, one reversal per entry, duplicate-source prevention, result revisions with cutoff and calculation version.
6. **Migration cutoff policy** — what legacy history is carried, what is shown with "legacy" provenance, and what is not reconstructed.
7. **Visual design** — the themed design system and every core screen (§ 5) as a clickable prototype: Overview, Calendar, My Work, Organisation, Project, Goals, approval inbox.
8. **Second pilot customer review** — entity model and prototype walked through with them; schema adjusted.
9. **Agent evaluation set** — 30–50 real requests with expected tool calls, for choosing the model by tool correctness, latency and cost.

**Exit gate:** journeys signed off by Sona and the second pilot customer; entity model, matrix and state machines frozen for Phases 2–4.

---

### Phase 2 — Workspaces + app shell (two tracks, one gate)

**Track A — Workspaces (customer isolation)**
- `workspaces`, `workspace_members`; `workspace_id` on every business table with **composite foreign keys** so no row can reference another workspace's row (FK checks bypass RLS, so this is enforced by keys, not policies).
- Workspace isolation as a **restrictive** RLS policy on every table; legacy owner-wide policies removed.
- Existing data migrated into a Sona workspace with reconciliation and a rehearsed rollback.
- Login → workspace(s) → switcher; run tokens, catalogue and jobs carry the workspace.
- **WhatsApp connections become workspace-owned records** (credentials, session state, routing, replies).
- **Durable job queue** in Postgres (retries, locking) for digests, reminders and notifications.

**Track B — App shell, theme, Overview v1, Calendar**
- Design system (§ 5) built in Tailwind + shadcn/ui: tokens, typography, cards, chips, pills, sidebar, calendar, timeline, list + detail.
- New shell: black sidebar with our menu, global search with scope chips, profile/notifications/settings.
- **Overview v1** on current data: greeting with a computed summary, four summary cards, *Needs attention* list with detail panel, right rail with calendar and today's timeline.
- **Calendar & events, fully working:** month view with week numbers, add/edit/delete events, participants, reminders (in-app + WhatsApp), today's timeline with a now-line, ICS export, and derived items (reporting deadlines, lock cut-offs; milestones and task due dates join in Phase 5).
- Legacy `page.js` screens stay reachable from the shell until replaced.

**Exit gate:** an owner from workspace A cannot read or reference anything in workspace B (tests at app, RLS and FK level); Sona data reconciles 100%; Overview v1 and the calendar work end to end, including a WhatsApp reminder delivered by the job queue.

---

### Phase 3 — People & units

**Status (local):** **gate-ready (local)** — migrations `012`–`014`, units/invitations/secondary assignments HTTP, people dual-write, `/people` UI slice, exit-gate integration test; see [PHASE3_EXIT.md](./PHASE3_EXIT.md). **Open for production:** product sign-off only ([phase3-people-units.md § 8](./phase3-people-units.md#8-product-input-queue)) plus live `012` reconcile and Sona pilot walkthrough.

- Typed unit tree; assignments (many per person, one primary) replacing the single `memberships.org_id`; composite workspace keys throughout.
- Migration of organisations → organisation units and memberships → assignments, keeping reporting lines.
- Customer-editable structure; invitations, acceptance, deactivation, password reset, ownership transfer; placeholder people converted to invitations.
- Screens: **Organisations** (org → branches → teams → people) and **People**, in the new design.
- Agent tools for people and units.

**Exit gate:** one person manages a branch and contributes to a team in another branch; Sona's structure has no placeholders in the schema; existing features unaffected.

---

### Phase 4 — Scoped permissions

- `can(actor, action, resource, scope)` implementing the Phase 1 matrix plus resource conditions (own submission, locked period, state).
- All HTTP routes, agent tools, WhatsApp handlers and jobs use it; `roles.js` and `actionAllowed()` retired; catalogue `allowed` derived from it.
- RLS extended to unit/project scope where practical; permission-change audit.

**Exit gate:** a generated test runs every matrix cell through HTTP and through the agent tool endpoint with identical results.

---

### Phase 5 — Projects & My Work

**First-release scope:** projects (accountable organisation, primary branch, participating units, manager, dates, priority, status, health with manual override + reason); milestones; tasks with list and board views; comments, mentions, activity; project updates; **My Work**; notifications in-app and on WhatsApp (via the Phase 2 job queue); WhatsApp intents for due work, completing tasks, commenting and posting updates; milestones and task due dates appear in the calendar; Overview gains a **Delivery** card.

**Deferred to Phase 9:** calendar/timeline project views, task dependencies, templates, attachments, workload estimates.

**Exit gate:** a Sona pilot team runs one real project from setup to delivery, including WhatsApp updates and reminders.

---

### Phase 6 — Targets & measurement ledger

- **Versioned targets** on any scope with type, aggregation, period, unit, direction, tolerance, approval requirement, checkpoints.
- **Report revisions** are immutable once approved; corrections create new revisions that need review.
- **Measurement ledger** — the only counting path: approved report revisions and approved task/milestone contributions each create ledger entries; persisted approval identities; one reversal per entry; no duplicate active entry per source.
- **Period results with revisions** — each result records its input cutoff, calculation version and input hash; a past result can be reproduced exactly, and a correction creates a new result revision instead of rewriting history.
- **Migration with a cutoff date:** new engine from the cutoff; legacy scores stay visible with "legacy scoring" provenance; legacy selection (highest-level submission per day) and aggregation (sum/average/latest) preserved where data is carried forward.
- **Goals & Metrics** screens; Overview gains a **Target attainment** card.

**Exit gate:** one full calendar month for Sona closes with results reproducible from the ledger, target versions, cutoff and calculation version; a reversed approval produces a new result revision with an audit trail. This completes the first commercial milestone journey.

---

### Phase 7 — Dashboards & analytics

- Role dashboards (owner, organisation, branch, project, contributor) in the § 5 design.
- Separate measures: task completion, target attainment, on-time delivery, reporting completeness; **freshness and coverage** shown with every figure.
- Trends, comparisons, drill-down to source records; filters for organisation, branch, team, project and dates with the scope always visible.
- CSV export; the 05:30 digest uses the same metrics; **Reports** screen.

**Exit gate:** reconciliation tests prove every displayed number equals an independent query over source records.

---

### Phase 8 — Commercial pilot

Assisted onboarding (setup wizard, CSV import with dry-run, templates, demo workspace); plans and entitlements (manual provisioning); usage tracking; error monitoring; backups covering **Postgres and the WhatsApp auth volume plus its encryption key**, with a tested restore; deployment rollback; workspace export and deletion; support runbook.

**Exit gate:** Sona and one external customer use it for four weeks with manageable support.

---

### Phase 9 — Expansion

Project calendar/timeline views, dependencies with cycle prevention, templates, attachments, workload and capacity, saved views, Google/Outlook calendar sync, integrations, self-service billing.

**Local gate:** [PHASE9_EXIT.md](./PHASE9_EXIT.md) — migration `021`, dependency graph, templates, attachments (`ATTACHMENTS_DIR`), saved views, workload, calendar/billing stubs, `expansion.test.js`, web timeline.

**Production deferrals:** live Google/Outlook OAuth, Stripe live checkout, full attachment CDN.

---

## 5. Visual direction (agreed)

The platform adopts the look of the supplied reference: warm, calm and card-based — implemented as **our own design system** with PortfolioOS branding and our navigation.

| Element | Direction |
|---------|-----------|
| Canvas | Warm cream background, generous spacing, large rounded content frame |
| Sidebar | Black, rounded, white text; sections **General** (Overview, My Work, Organisations, Projects, Goals & Metrics, Calendar, People, Reports) and **Tools** (Agent, WhatsApp, Settings), Log out at the bottom; collapsible |
| Header | Round search button + search field with scope chips (Organisations · Projects · People · Goals); profile, notifications and settings as round black icon buttons |
| Greeting | Large bold "Good morning, Thyagu" with a one-line computed summary (e.g. "3 organisations need attention, 5 approvals waiting, 1 milestone due today") |
| Summary cards | Four pastel cards — butter, rose, olive, periwinkle — each with a title, three headline figures with captions, and a chart (bars, line with marker, counts, mini-stats) and a large soft background shape |
| Lists | Pill-shaped rows with an icon tile, name, sub-label and a time/status chip; selected row highlighted in the card colour |
| Detail panel | Card next to the list showing the selected record: header, tags, labelled fields, actions |
| Right rail | Month calendar (week numbers, today highlighted in rose, prev/next), black **Add event** pill with refresh and export buttons, **Today's timeline** with a time rail, event cards, participants avatars, dashed **now** line, **View all** |
| Status | Good/watch/bad always shown as icon + text, using dedicated status colours distinct from the decorative pastels |
| Mobile | Sidebar collapses to a bottom bar; right rail stacks below; My Work, approvals and reporting first |

**Overview v1 content (Phase 2, current data):**

| Slot | Content |
|------|---------|
| Butter card — *Organisations* | Locked / open / needs-attention counts; bar per organisation split good/watch/bad |
| Rose card — *Performance* | Share of KPIs good per day, last 14 days; marker on today; average / lowest / highest |
| Olive card — *Reporting* | Submitted / awaiting review / missing today |
| Periwinkle card — *Approvals* | Pending approvals, open escalations, days awaiting lock |
| Needs attention + detail | Worst KPIs (later also projects and tasks) with owner, value vs goal, recent trend; actions: open, message owner on WhatsApp |
| Right rail | Calendar, Add event, Today's timeline |

Phase 5 swaps *Reporting* for **Delivery** (projects on track / at risk / late) where projects exist; Phase 6 adds **Target attainment**.

---

## 6. Decisions and owners

| Decision | Needed by | Status |
|----------|-----------|--------|
| First-release scope | Phase 1 | **Agreed** |
| Visual direction (§ 5) | Phase 1 | **Agreed** |
| Design stack: shadcn/ui + Tailwind + Recharts | Phase 1 | Proposed default |
| Second pilot customer | Phase 1 week 1 | **Open** |
| Agent model (from evaluation set) | End of Phase 1 | Open |
| ADK generic client and maintainer (F14) | Phase 0 | Open |
| Migration cutoff date for targets | Phase 1 (policy), Phase 6 (date) | Open |
| Hosting, region, backup retention | Phase 8 | Open |
| Pricing and packaging | Phase 8 | Hypothesis |

## 7. Engineering review of revision 1 — resolutions

| Review item | Resolution in revision 2 |
|-------------|--------------------------|
| P1-1 Permissive workspace policy ORs with owner policy | Workspace isolation is a `RESTRICTIVE` policy; legacy owner policies dropped; owner-A-vs-workspace-B test (BUILD § 6.2) |
| P1-2 Cross-workspace references | Composite `(workspace_id, id)` keys on every workspace table; polymorphic references replaced by typed FK columns + exactly-one checks (BUILD § 3, § 6.3) |
| P1-3 Submit vs lock race | Shared period row lock taken by every submission mutation, approval and lock (F4, BUILD § 4.4) |
| P1-4 Corrections becoming scored | Explicit state machine; corrections return to *submitted*; scoring counts *validated/locked* only; audited reopen (F5, BUILD § 4.5) |
| P1-5 WhatsApp identity | New Phase 0 step F10 (BUILD § 4.10) |
| P1-6 Ledger and result guarantees | Single counting path via the ledger; immutable revisions; persisted approvals; reversal constraints; result revisions with cutoff and calc version (BUILD § 10) |
| P1-7 Migration promises | Cutoff policy; legacy provenance; legacy selection/aggregation preserved; legacy tables archived, not dropped (BUILD § 10.5) |
| P1-8 Migration runner false success | New Phase 0 step F2 (BUILD § 4.2) |
| Auth before RLS; connection held across agent turn | F11 bootstrap functions; F13 short transactions (BUILD § 4.11, § 4.13) |
| Password/date inventory gaps | `docker/entrypoint.sh` and frontend `todayISO()` added (F7, F8) |
| Backups miss WhatsApp state | WhatsApp volume + encryption key in backup and restore tests (F15, Phase 8) |
| Phase dependencies | Job queue → Phase 2; Overview v1 → Phase 2; Phase 6 gate includes a live month |
| ADK as coordinated dependency | F14 rewritten as coordination with the maintainer |
