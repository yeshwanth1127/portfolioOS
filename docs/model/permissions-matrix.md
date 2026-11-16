# Permission matrix — Phase 0 roles (as implemented)

Cross-reference: [BUILD.md § 4.6](../BUILD.md#46-f6-approval-checks), [§ 8](../BUILD.md#8-phase-4--scoped-permissions) (`can()`), [§ 13](../BUILD.md#13-agent-integration-all-phases) (agent `requires`).

**Roles** (`role_level` on `memberships`): `owner`, `manager`, `vice_manager`, `team_lead`, `member`.

**Scopes**

| Scope | Meaning in code |
|-------|-----------------|
| **portfolio** | `membership.role === 'owner'` (`app.role = owner` in RLS) |
| **org** | `membership.org_id`; non-owners are confined to one organisation (HTTP `loadOrgFor`, RLS `app_org()`) |
| **workspace** | `workspace_id` on the row; enforced by restrictive RLS ([BUILD § 6.2](../BUILD.md#62-rls-restrictive-isolation--scoped-access)) |
| **subtree** | Recursive `parent_id` from caller's membership (team-lead review, `activity_entries` RLS) |
| **self** | `membership.id` (own submissions, own KPI ownership for `member`) |

**Enforcement today**

1. **HTTP / domain** — ad hoc checks in `packages/api/src/domain/*`, `roles.js`, `routes.js`.
2. **Agent** — `actionAllowed(role, action)` in `agent-tools.js` (catalogue `allowed` flag); dispatch still runs domain checks.
3. **Database** — RLS on sensitive tables; not a full substitute for action-level rules.
4. **Phase 4 `can()`** — not implemented; cells below marked **Phase 4** should move to `core/permissions/can.js` + generated tests ([BUILD § 8](../BUILD.md#8-phase-4--scoped-permissions)).

Legend: **Y** allowed (may still fail domain rules), **N** denied at catalogue/route gate, **Y\*** allowed with extra conditions in domain, **—** not applicable.

---

## Read & browse

| Action | Scope | owner | manager | vice_manager | team_lead | member | HTTP | Agent |
|--------|-------|:-----:|:-------:|:------------:|:---------:|:------:|------|-------|
| List / show organisations | portfolio / org | Y | Y (org) | Y (org) | Y (org) | Y (org) | `GET /orgs`, `GET /orgs/:slug` | `list_orgs`, `show_org` |
| List KPIs | org | Y | Y | Y | Y | Y | `GET /orgs/:slug/kpis` | `list_kpis` |
| Show KPI / scores | org | Y | Y | Y | Y | Y | `GET /scores` | `show_kpi`, `list_scores` |
| List people | org | Y | Y | Y | Y | Y | `GET /orgs/:slug/people` | `list_people`, `find_person`, `who_owns` |
| List submissions | org | Y | Y | Y | Y | Y | `GET /submissions` | (via `show_kpi`, `list_waiting`, …) |
| Overview dashboard | portfolio / org | Y | Y (org filter) | Y (org) | Y (org) | Y (org) | `GET /dashboards/overview` | — |
| Calendar feed / ICS | workspace + RLS | Y | Y | Y | Y | Y | `GET /calendar`, `GET /calendar.ics` | `list_events` |
| List escalations | org | Y | Y | Y | Y | Y | — | `list_escalations` |
| Check readiness (gaps) | portfolio | Y | N | N | N | N | `GET /readiness` (owner only) | `check_readiness` **Y\*** (agent allows all roles; domain may return empty) |
| Agent web UI / settings | portfolio | Y | N | N | N | N | agent routes, settings | — |
| Tool catalogue | self | Y | Y | Y | Y | Y | `GET /agent/tools/catalog` | — |

RLS: non-owner sees org-scoped rows; owner sees all orgs in workspace (`009_enforce_rls.sql`). Activity log: manager+ see full org activity; members see subtree (`subtree_scope`).

---

## Reporting & submissions

| Action | Scope | owner | manager | vice_manager | team_lead | member | Domain / notes | Agent |
|--------|-------|:-----:|:-------:|:------------:|:---------:|:------:|----------------|-------|
| Record number | org, day open | Y | Y | Y | Y | Y\* | `recordNumber`: **member** only if `kpi.owner_id === membership.id`; others not blocked by owner check ([BUILD § 4.5](../BUILD.md#45-f5-submission-state-machine) says KPI owner or reviewer — **vice_manager/manager can record without owning KPI**) | `record_number` |
| Amend number | org | Y | Y\* | Y\* | Y\* | Y\* | Submitter or `canReviewSubmissions`; period not locked | `amend_number` |
| Withdraw submission | org | Y | Y\* | Y\* | Y\* | Y\* | Same as amend; not if `validated` | `withdraw_submission` |
| Approve / reject | org / subtree | Y | Y | Y | Y\* | N | `validateSubmission`: reviewers; **team_lead** only if submitter in subtree; no self-review except **owner** and **manager** ([BUILD § 4.6](../BUILD.md#46-f6-approval-checks)) | `validate_submission` |
| Lock day | org | Y | Y | N | N | N | `canLockDay` — **vice_manager cannot lock** (matches BUILD "owner/manager") | `lock_day` |
| Reopen day | org | Y | Y | N | N | N | Same | `reopen_day` |

**Phase 4:** unify approve scope (submitter vs KPI owner subtree per BUILD § 4.6 wording), record rules, and self-approval exceptions under `can()`.

---

## KPI register & goals

| Action | Scope | owner | manager | vice_manager | team_lead | member | Domain | Agent |
|--------|-------|:-----:|:-------:|:------------:|:---------:|:------:|--------|-------|
| Set target / goal | portfolio | Y | N | N | N | N | `setTargetByCode`, `set_target` | `set_target` |
| Add / update / retire KPI | org | Y | N | N | N | N | `addKpi`, `updateKpiRegister`, `retireKpi` | `add_kpi`, `update_kpi`, `retire_kpi` |
| Assign KPI owner | org | Y | Y | Y | N | N | `managesOrg` | `assign_kpi_owner` |
| Change rollup_method only | org | Y | N | N | N | N | `updateKpiRegister` | `update_kpi` |

Managers may reassign owners but not change goals or register definition — product copy says "Thyagu" for owner-only KPI mutations.

---

## People & org profile

| Action | Scope | owner | manager | vice_manager | team_lead | member | Domain | Agent |
|--------|-------|:-----:|:-------:|:------------:|:---------:|:------:|--------|-------|
| Add person | org | Y | Y | Y | N | N | `managesOrg`; assignable roles differ (owner may assign up to manager; manager: member, vice_manager only) | `add_person` |
| Update / remove person | org | Y | Y | Y | N | N | `managesOrg` | `update_person`, `remove_person` |
| Update org metadata | org | Y | Y | Y | N | N | `updateOrg` | `update_org` |
| Decide escalation | portfolio | Y | N | N | N | N | `decide_escalation` | `decide_escalation` |

---

## Calendar events

| Action | Scope | owner | manager | vice_manager | team_lead | member | Domain | Agent |
|--------|-------|:-----:|:-------:|:------------:|:---------:|:------:|--------|-------|
| Create event | workspace | Y | Y | Y | Y | Y | Non-owner defaults `org_id` to own org | `add_event` |
| Edit / delete event | event | Y | Y\* | Y\* | N | Y\* | Creator, or owner, or manager/vice on same org as event; **team_lead** not in `canEditAny` for others' events | `move_event` |
| RSVP | self | Y | Y | Y | Y | Y | Participant row required | (HTTP `POST …/respond`) |

**Gap:** agent allows `add_event` for team_lead; edit rules are stricter than create (team_lead can create but not edit another person's org event).

---

## Account

| Action | owner | manager | vice_manager | team_lead | member | Agent |
|--------|:-----:|:-------:|:------------:|:---------:|:------:|-------|
| Show / update me | Y | Y | Y | Y | Y | `show_me`, `update_me` |

---

## Workspace roles (`workspace_members.workspace_role`)

Not the same as `role_level`. Today:

- Created with workspace backfill: users with any `owner` membership → workspace `owner`, else `member` (`010`).
- New people get `workspace_role = 'member'` on insert (`people.js`).
- **`admin`** exists in schema but has **no distinct API behaviour** yet beyond being a workspace member under RLS.

**Phase 4 `can()`** should include `workspaceRole` in the actor ([BUILD § 8](../BUILD.md#8-phase-4--scoped-permissions)).

---

## HTTP vs agent mismatches (documented, not aspirational)

| Item | HTTP | Agent `actionAllowed` |
|------|------|------------------------|
| Readiness report | Owner only | All roles (read action) |
| Owner agent tab / settings | Owner only | N/A |

Domain logic still applies after agent allows an action.

---

## Future: Phase 4 matrix consumption

BUILD specifies `docs/model/permissions.csv` → `core/permissions/matrix.js`. This markdown is the human-readable twin for review; CSV generation is a follow-up. Every **Phase 4** row should gain:

- `action` string (e.g. `submission.approve`)
- `requires` on catalogue tools ([`agent-tool-schemas.js`](../../packages/api/src/agent-tool-schemas.js) partial today)
- Identical outcomes for HTTP and `POST /agent/tools/portfolio_os` per [BUILD § 8](../BUILD.md#8-phase-4--scoped-permissions)
