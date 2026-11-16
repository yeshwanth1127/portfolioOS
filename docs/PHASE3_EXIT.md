# Phase 3 exit checklist (engineering gate — local)

One-page gate before calling Phase 3 **engineering** done locally. Production-only steps are in [Remaining (production)](#remaining-production); see [phase3-people-units.md](./phase3-people-units.md), [BUILD.md § 7](./BUILD.md#7-phase-3--people--units), and [ROADMAP.md § Phase 3](./ROADMAP.md#phase-3--people--units).

**Exit gate (ROADMAP):** one person manages a branch and contributes to a team in another branch; Sona's structure has no placeholders in the schema; existing features unaffected.

| Check | Done when | Verify |
|-------|-----------|--------|
| **Typed unit tree (012 + 013)** | Organisation units, child types, RLS isolation, manager subtree | `npm test` → `tests/integration/units.test.js` |
| **Customer structure edits** | POST/PATCH `/units` (branch, department, team) | same file (*owner creates branch…*, *PATCH /units*) |
| **Invitations HTTP** | Create, list, public accept | `tests/integration/invitations.test.js` |
| **People dual-write** | Primary people mutations sync `assignments` (+ legacy `memberships`) | `units.test.js` → *people mutations dual-write*; `tests/integration/org-people.test.js` |
| **Secondary assignments** | `POST /assignments` with `is_primary: false`; **no** new `memberships` row | `units.test.js` → *exit gate: secondary assignment…* |
| **Cross-branch visibility** | Actor sees primary branch + secondary team in `/units/tree`; cannot assign in workspace B | same exit-gate test |
| **Workspace isolation** | Units/assignments stay in workspace A | `units.test.js` → *workspace isolation*; `workspaces.test.js` |
| **Agent tools** | `list_units`, people/org tools on catalogue | `npm test` → `tests/integration/agent-tools.test.js` |
| **KPI / submissions regression** | Record + validate paths unchanged | `submissions.test.js`, exit-gate submit line in `units.test.js`; full `npm test` |
| **People UI** | `/people` roster + invites + structure | Manual or Playwright (optional) |
| **Legacy Team tab hint** | Link to `/people` for owners/managers | Legacy `/` Team tab |
| **Default test runner** | All integration + concurrency suites green | `npm test` (from repo root) |
| **Web production build** | Next.js compiles | `npm run build -w @portfolio-os/web` |

## Commands (local)

```bash
# Full automated gate (Phase 3 + regression)
npm test

# Phase 3–focused suites
npm test -- tests/integration/units.test.js tests/integration/invitations.test.js tests/integration/org-people.test.js

# Web build (People + legacy shell)
npm run build -w @portfolio-os/web
```

## POST /assignments (secondary only)

| Field | Rule |
|-------|------|
| `is_primary` | Must be `false` — primary assignments use `POST /orgs/:slug/people` (dual-writes `memberships` + primary `assignments`). |
| `user_id` | Must already be in `workspace_members` for the workspace. |
| `unit_id` | Target unit in the same workspace; manager or owner for that unit's organisation. |
| RLS | `ws_isolation` on `assignments`; visibility extended in `014_assignment_unit_visibility.sql` so actors see ancestor chains of all active assignments. |
| Legacy | **No** `memberships` insert or update on this path. |

## Test map (Phase 3–relevant suites)

| Suite | Phase 3 coverage |
|-------|------------------|
| `units.test.js` | Backfill parity, tree scope, structure CRUD, dual-write, **exit gate** (two assignments, POST `/assignments`) |
| `invitations.test.js` | Create, list, accept, permissions |
| `org-people.test.js` | Org people list, add/update/remove, permissions |
| `workspaces.test.js` | Workspace A ≠ B (still required) |
| `submissions.test.js` | KPI submit/lock unchanged |
| `agent-tools.test.js` | `list_units`, catalogue actions |
| `calendar.test.js` | Overview + calendar (Phase 2; regression) |
| `sona-reconcile.test.js` | Workspace reconcile (regression) |

## Fixture (§8.11 cross-branch gate)

`tests/helpers/env.js` seeds **workspace A**:

- `alphaBranch` — branch under Alpha org (`Cross Branch Manager` primary assignment unit).
- `betaCrossTeam` — team under Beta branch (secondary assignment target in exit-gate test).

## Explicitly deferred (not local gate)

| Item | Notes |
|------|--------|
| **Membership write-freeze** | `memberships` remains writable; KPI FKs unchanged ([phase3-people-units.md](./phase3-people-units.md)) |
| **Full ownership transfer UI** | Workspace role move; product §8.9 |
| **Password reset flow** | Account routes; ROADMAP Phase 3 bullet |
| **Assignments-only people reads** | `GET /orgs/:slug/people` still membership-centric; full roster via `/people` + future `GET /units/:id/people` |
| **`reconcile/012_units_assignments.sql`** | Production cutover script (pattern 010) |
| **`add_assignment` agent tool** | Catalogue gap; HTTP `/assignments` is source of truth for secondaries |

## Remaining (production)

| Item | Why not local |
|------|----------------|
| **§8 product sign-off** | Branch/team seed on Sona workspace, assignment id strategy, invitation channel, ownership transfer rules — [phase3-people-units.md § 8](./phase3-people-units.md#8-product-input-queue) |
| **012 reconcile on live data** | Counts + reporting integrity on production DB after `012` |
| **Sona placeholder purge** | Zero `pending_name` / unnamed roster in production data |
| **Pilot walkthrough** | Sona edits structure, invites user, accepts invitation in browser |
| **F14 ADK** | Generic catalogue client — [F14-adk-coordination.md](./F14-adk-coordination.md); **no ADK edits for Portfolio tools** |

**Local engineering gate:** all `npm test` rows green + web build; document prod/product items above before investor/production sign-off.
