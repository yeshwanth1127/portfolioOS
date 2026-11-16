# Reports

Reports page (`/reports`) for every role. Pick a type, a period and who it covers; Orbit computes the figures from live data, the Qlix agent writes the summary, and the report can be viewed, printed to PDF, or downloaded as Excel / CSV.

## Flow

```
POST /reports/generated {report_type, from, to, scope_kind, scope_ref, instructions}
  → generated_reports row (queued)            caller's transaction
  → runReport() after commit                  packages/api/src/modules/reports/index.js
      1. datasets: SQL in the requester's scope (RLS on)        datasets.js
      2. layout: tiles / charts / tables per type + plain summary   types.js
      3. agent-runner /run  channel=report profile=report report_id
           run token carries {profile, report_id} → catalogue serves only `report_data`
           agent replies  SUMMARY / HIGHLIGHTS / WATCH
      4. narrative check: any line quoting a number not in the datasets is dropped   narrative.js
      5. status ready (agent unavailable → plain summary, still ready)
GET  /reports/generated/:id            page view (polls while running)
GET  /reports/generated/:id/export.xlsx|csv
POST /reports/generated/:id/submit     to memberships.parent_id (or the owner)
```

The agent never supplies a figure. Tiles, charts and tables come only from `datasets`; the agent writes words around them.

## Types

| Type | Roles | Source |
|---|---|---|
| `kpi_performance` KPI targets | owner, manager, vice, team lead | `scores`, `kpis` |
| `reporting` KPI reporting | same | `submissions` vs each KPI's cadence |
| `task_delivery` Tasks & delivery | everyone | `tasks` |
| `projects` Projects & milestones | leads | `projects`, `tasks`, `milestones`, `project_updates` |
| `workload` Workload & assignments | leads | open `tasks` per assignee (as of today) |
| `people` People scorecard | leads | all of the above + attendance |
| `attendance` Attendance | leads | `attendance_events` |
| `logins` Sign-ins | owner | `auth_events` |
| `my_work` Work report | everyone | tasks, comments, project updates, KPI submissions, attendance |

Add a module: write a dataset builder in `datasets.js`, add a type in `types.js`. Nothing in ADK changes.

## Scope

| Role | May cover |
|---|---|
| owner | workspace, any org, any person |
| manager / vice manager | their org, anyone in it, themselves |
| team lead | their team (everyone under them via `memberships.parent_id`), anyone in it, themselves |
| member | themselves |

Reports are visible to the requester, the person they were submitted to, and the owner (RLS on `generated_reports`).

## Attendance and sign-ins (migration 023)

- `attendance_events`: insert-only clock in / out. Web: topbar button. WhatsApp / agent: `clock_in`, `clock_out` ("@ in", "@ out"). Hours = in→out pairs; a day without a clock-out is flagged, never estimated.
- `auth_events`: login, workspace switch, logout (written by `auth.record_auth_event`). Logout exists only when the person presses Sign out.

## Agent / WhatsApp

`generate_report` (any role) queues a report; on WhatsApp the summary and link (`PORTFOLIO_WEB_URL`) are sent to the requester when ready.

## PDF

The report page prints cleanly (sidebar and buttons hidden); "PDF" opens the browser's print dialog → Save as PDF. No server-side Chromium.

## Settings

| Env | Default | |
|---|---|---|
| `PORTFOLIO_WEB_URL` | — | link in WhatsApp report messages |
| `REPORTS_AGENT` | on | `off` = plain summaries only |
| `REPORTS_AGENT_TIMEOUT_MS` | 120000 | agent narrative timeout |
| `REPORTS_RUNNER_URL` | `AGENT_RUNNER_URL` | override (tests) |

Tests: `tests/integration/reports.test.js`.
