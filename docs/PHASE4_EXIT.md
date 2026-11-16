# Phase 4 exit gate — scoped permissions

Human matrix: [docs/model/permissions-matrix.md](model/permissions-matrix.md)  
Machine subset (slice 4.0): [docs/permissions.csv](permissions.csv) → `packages/api/src/core/permissions/matrix.js`  
Runtime: `packages/api/src/core/permissions/can.js` — `can(membership, action, resource?)` → boolean.

## Slice 4.0 — done when

- [x] `can()` implements the documented Phase 4 subset (11 actions; Phase 5 adds `project.edit` / `task.assign` in slice 5.0) with resource hints where the matrix marks **Y\***.
- [x] `matrix.js` + `permissions.csv` stay in sync for those actions.
- [x] One domain path (`recordNumber`) uses `can()`; behaviour unchanged.
- [x] One agent path (`validate_submission` → `submission.approve`) uses `can()` inside `actionAllowed`.
- [x] Table-driven tests: `tests/integration/permissions-matrix.test.js` (≥15 cells; HTTP parity deferred).

## Slice 4.1 — done when

- [x] Domain: `validateSubmission` → `submission.approve`; `amendNumber` / `withdrawSubmission` → `submission.amend`; `lockDay` / `reopenDay` → `day.lock` / `day.reopen`.
- [x] `permissionDenied(membership, action)` in `packages/api/src/core/permissions/permission-denied.js`.
- [x] `actionAllowed`: all matrix-mapped tool actions delegate via `canRoleGate()` (role gate); domain keeps full `can()`.
- [x] `permissions-matrix.test.js` expanded (full 55-cell role gate + tool parity spot checks).

## Slice 4.2 — done when

- [x] Domain KPI register: `addKpi`, `updateKpiRegister`, `retireKpi`, `setTargetByCode` → `kpi.edit`; `assignKpiOwner` → `person.manage`.
- [x] Domain people: `addPerson`, `updatePerson`, `removePerson` → `person.manage`.
- [x] Domain org metadata: `updateOrg` → `unit.manage`.
- [x] Units module: `createUnit`, `updateUnit` → `unit.manage`.
- [x] Invitations: `createInvitation` → `invitation.create` (`acceptInvitation` remains public token flow).
- [x] Calendar: `createEvent` → `calendar.event.create`; `updateEvent` / `deleteEvent` → `calendar.edit` (incl. mgr/vice same-org via `eventOrgId` in `can()`).
- [x] `permissions-domain.test.js` + expanded matrix cases for `calendar.edit` org scope.

## Slice 4.3 — done when

- [x] `requireRoleGate` / `requirePermission` in `packages/api/src/core/permissions/require-permission.js`; `gatedMutate` on mutating HTTP routes in `routes.js`.
- [x] Catalogue `allowed` derived from `TOOL_TO_MATRIX_ACTION` + `canRoleGate` (`tool-matrix.js`, `getToolCatalog`).
- [x] `actionAllowed` map-driven; `set_target` / `decide_escalation` → `kpi.edit` role gate.
- [x] Generated matrix + HTTP/agent parity: `permissions-matrix.test.js`, `permissions-http-agent-parity.test.js`.
- [x] `createAssignment` → `person.manage` via `can()`; removed unused `canAssignKpiOwner`.
- [x] WA gateway: no local matrix; agent turn delegates to API (`app.js` comment + runner).
- [x] Jobs: `digest/run` uses system actor; no mutating matrix actions (outbox only).
- [x] RLS / assignment scope: existing `012`–`014` + `listUnitTree` assignment scope; no new migration this slice.
- [x] Permission audit: migration `015_audit_log.sql`; `notePermissionCheck` in `permission-audit.js`; HTTP denials via `roleGateDeny` in `routes.js`; agent denials in `logToolCall` + `agent_tool_calls.allowed`. Scope: `permission.allow` / `permission.deny` kinds until Phase 6+ broadens `audit_log`.

### Remaining ad-hoc checks (justified)

| Location | Check | Why not `can()` alone |
|----------|-------|----------------------|
| `routes.js` | Owner-only agent tab, `/readiness`, WhatsApp settings | Product UI gates, not matrix actions |
| `submissions.js` `mayEdit` | Submitter vs reviewer on amend | State machine + ownership beyond role gate |
| `org-access.js`, `lookup.js` | Cross-org visibility | RLS companion; returns `not_found` / `forbidden` before domain |
| `people.js` | Manager promotion rules | Assignment policy, not in CSV matrix |
| `invitations.js` `listInvitations` | Owner-only list | Read path; matrix covers `invitation.create` only |
| `can.js` | `canReviewSubmissions`, `managesOrg`, `isOwner` | Encapsulated inside `can()` resource rules |

## Migration order (do not big-bang routes)

1. **Domain services** — done (4.2).
2. **`packages/api/src/routes.js`** — done (4.3 `gatedMutate`).
3. **`packages/api/src/agent-tools.js`** — done (`tool-matrix.js`).
4. **`services/wa-gateway`** — done (API delegation).
5. **Jobs** — done (digest read-only mutations).
6. **`roles.js`** — `ROLE`, labels, `assignableRolesFor`, hierarchy helpers kept; auth-only helpers used inside `can()` only.

## Full exit gate (Phase 4 complete)

- [x] Generated test runs **every** matrix cell through `canRoleGate` and tool catalogue parity; HTTP + `POST /agent/tools/portfolio_os` agree on role-gate deny (`permissions-http-agent-parity.test.js`).
- [x] `can(membership, action, resource)` matches BUILD §8 subset (assignments visibility partial; workspace role + org resource hints).
- [x] Product permission checks on mutations go through `can()` (+ route `requireRoleGate`); justified ad-hoc list above.

**Phase 4: gate-ready (local).**
