# Submission & period states — as implemented

Normative intent: [BUILD.md § 4.4 F4](../BUILD.md#44-f4-period-lock), [§ 4.5 F5](../BUILD.md#45-f5-submission-state-machine), [§ 4.6 F6](../BUILD.md#46-f6-approval-checks).

Code: `packages/api/src/domain/submissions.js`, `signoffs.js`, `core/locks.js`, `scoring.js`. Schema: `submissions`, `amendments`, `org_periods`, `signoffs`, enum `sub_state` in [`001_schema.sql`](../../packages/db/migrations/001_schema.sql).

---

## Submission states (`sub_state`)

| State | In DB enum | Assigned today? | Scored? |
|-------|------------|-----------------|---------|
| `draft` | Yes | No — `recordNumber` always sets `submitted` | No |
| `submitted` | Yes | Yes | No |
| `validated` | Yes | Yes (approve) | Yes (at lock and in rollups) |
| `rejected` | Yes | Yes | No |
| `locked` | Yes | Yes (lock day on validated rows) | Yes |
| `amended` | Yes (legacy) | **No** — migration `007` moved existing `amended` → `submitted`; code never writes `amended` | No (removed from scoring path) |

Scoring selects `state IN ('validated','locked')` only (`scoring.js`).

Unique key: `(kpi_id, period_date, level)` where `level` = submitter's `role_level` at record time — multiple levels can report the same KPI-day; roll-up picks highest level ([BUILD § 1.3](../BUILD.md#13-behaviour-that-later-phases-must-preserve-or-deliberately-change)).

---

## Period state (`org_periods.status`)

| Status | Meaning |
|--------|---------|
| `open` (default) | Reporting and review allowed unless submission row is `locked`. |
| `locked` | Day closed; validated submissions become `locked`; scores computed for the org-day. |

Row created on demand: `lockPeriod` inserts `(org_id, period_date)` if missing, then `SELECT … FOR UPDATE` (`core/locks.js`).

`signoffs` row written on lock for backward compatibility ([BUILD § 4.4](../BUILD.md#44-f4-period-lock)).

---

## State machine (implemented)

| From | Action | To | Who (code) | Preconditions |
|------|--------|-----|------------|---------------|
| — | record / correct | `submitted` | Any role; **member** must own KPI | `org_periods` not `locked`; submission not `locked`; `period_date` ≤ today |
| `submitted` | approve (`accept: true`) | `validated` | `canReviewSubmissions` + scope rules | State must be `submitted`; reject reason empty |
| `submitted` | reject | `rejected` | Same | Non-empty `reason` |
| `rejected` | record / `amendNumber` | `submitted` | Submitter or reviewer (`mayEdit`) | Period open; writes `amendments` if value changed |
| `validated` | `amendNumber` | `submitted` | Submitter or reviewer | Clears `validated_by/at`; writes `amendments`; needs review again |
| `submitted` / `rejected` | `withdrawSubmission` | (row deleted) | Submitter or reviewer | Not `validated`; amendments cascade delete |
| `validated` | lock day | `locked` | `owner`, `manager` only | Via `lockDay` |
| `locked` | — | — | — | Immutable until day reopened |
| (day locked) | reopen | day `open`; submissions `locked`→`validated` | `owner`, `manager` | `reopen_reason` required; deletes `signoffs` and `scores` for that org-day |

Operations that take the period lock first: `recordNumber`, `amendNumber`, `withdrawSubmission`, `validateSubmission`, `lockDay`, `reopenDay` ([BUILD § 4.4](../BUILD.md#44-f4-period-lock)).

### ASCII flow

```
                    record / correct
                         │
                         ▼
                    submitted ──approve──► validated ──lock day──► locked
                         │                      │
                      reject                  amend
                         │                      │
                         ▼                      ▼
                    rejected ──record────────► submitted
```

---

## Approval rules (F6) — code detail

`validateSubmission`:

1. Caller in `owner | manager | vice_manager | team_lead` (`canReviewSubmissions`).
2. Submission state must be `submitted`.
3. **Self-approval:** blocked if `submitted_by === membership.id` unless role is `owner` or `manager`.
4. **Team lead:** only if `reportsInto(submitted_by, team_lead)` (submitter in reporting subtree).
5. **Manager / vice_manager / owner:** org must match (non-owner cannot cross org); no subtree check for vice_manager/manager.

**Documented gap vs BUILD § 4.6 text:** BUILD names "KPI owner" for team-lead scope; code keys off **submitter** membership id, not `kpis.owner_id`. Confirm with Sona whether review scope should follow KPI ownership for some roles.

**Vice_manager** can approve org-wide; cannot lock/reopen (`canLockDay` is owner/manager only) — aligned with BUILD lock authority.

---

## Corrections (`amendments`)

- Inserted when value changes on record (re-entry) or on `amendNumber`.
- `ON DELETE CASCADE` from submission — withdrawing unapproved submission deletes amendment rows ([BUILD § 4.5](../BUILD.md#45-f5-submission-state-machine)); durable audit for withdrawals waits for Phase 4 `audit_log`.

---

## Lock day behaviour

`lockDay` ([`signoffs.js`](../../packages/api/src/domain/signoffs.js)):

1. Refuses future dates.
2. If period already locked → idempotent `{ already_locked: true }`.
3. Sets `org_periods.status = 'locked'`, upserts `signoffs`.
4. `UPDATE submissions SET state = 'locked' WHERE state = 'validated'`.
5. Counts remaining `submitted` / `rejected` as `left_unreviewed`.
6. Calls `scoreOrgDay`.

---

## Reopen day behaviour

`reopenDay`:

1. Requires period status `locked` and non-empty reason.
2. Sets `org_periods` to `open`, records `reopened_by/at/reopen_reason`.
3. Deletes `signoffs` for that day.
4. `locked` submissions → `validated`.
5. Deletes `scores` for that org-day (recomputed on next lock).

**Note:** BUILD mentions `audit_log` on reopen; **no `audit_log` table** in schema yet — only columns on `org_periods`.

---

## Interaction with workspace RLS

Submissions and `org_periods` are workspace-scoped with org-scoped permissive policies inside the workspace (`010` + `009`). Behaviour is unchanged from Phase 0 except rows cannot leak across workspaces.

---

## Phase 6+ (not implemented here)

Approved report **revisions**, ledger entries, and task-linked counting replace the MVP submission row as the source of truth ([BUILD § 10](../BUILD.md#10-phase-6--targets--measurement-ledger)). Until cutover, this document describes the live MVP path only.
