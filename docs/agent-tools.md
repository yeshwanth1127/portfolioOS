# Portfolio OS — HTTP API ↔ agent tools

All tools are invoked with `POST /agent/tools/portfolio_os` and body `{ "action": "<name>", ... }`.

**Catalogue (for agent runtimes):** `GET /agent/tools/catalog` returns `playbook`, and per-tool `summary`, `input_schema` (JSON Schema), `requires` (permission hint on writes), and `allowed` for the caller. ADK must build its tool schema from this response — do not hardcode Portfolio actions in ADK. See [AGENTS.md](../AGENTS.md).

## Infra (no tool)

| Method | Route |
|--------|--------|
| POST | `/auth/login` |
| GET | `/health` |
| GET/POST | `/agent/chat`, `/agent/chat/sessions` |
| POST | `/agent/runs`, `/agent/chat` |
| GET/POST | `/settings/whatsapp*` |
| POST | `/digest/run` |

Gateway route `POST /agent/tools/portfolio_os` dispatches tools; it is not a business action.

## Read tools

| Tool | REST |
|------|------|
| `check_readiness` | `GET /readiness` (owner; tool also works scoped) |
| `check_day` | *(no single route; signoff + scores)* |
| `list_kpis` | `GET /orgs/:slug/kpis` |
| `show_kpi` | KPI + scores |
| `list_waiting` | `GET /submissions` (subset) |
| `list_off_track` | `GET /scores` (subset) |
| `who_owns` | *(from KPI row)* |
| `find_person` | `GET /orgs/:slug/people` (search) |
| `list_escalations` | *(DB only)* |
| `list_orgs` | `GET /orgs` |
| `show_org` | `GET /orgs/:slug` |
| `list_people` | `GET /orgs/:slug/people` |
| `list_scores` | `GET /scores` |
| `list_pending` | *(owners/managers nudge)* |
| `show_me` | `GET /me` |
| `list_projects` | `GET /projects` |
| `list_tasks` | `GET /projects/:id/tasks` |
| `my_tasks` | `GET /my-work` |
| `connect_calendar` | `GET /integrations/calendar/status` (read-only status; owner connects via HTTP) |

## Write tools

| Tool | REST |
|------|------|
| `record_number` | `POST /submissions` |
| `set_target` | `POST /kpis/target` |
| `add_kpi` | `POST /orgs/:slug/kpis` |
| `update_kpi` | `PATCH /kpis/:id` (register fields) |
| `assign_kpi_owner` | `PATCH /kpis/:id` (`owner_id`) |
| `retire_kpi` | `DELETE /kpis/:id` |
| `add_person` | `POST /orgs/:slug/people` |
| `update_person` | `PATCH /people/:id` |
| `remove_person` | `DELETE /people/:id` |
| `amend_number` | `PATCH /submissions/:id` (`value`, `reason`; goes back for approval) |
| `withdraw_submission` | `DELETE /submissions/:id` |
| `validate_submission` | `POST /submissions/:id/validate` |
| `lock_day` | `POST /orgs/:slug/signoff` |
| `reopen_day` | `POST /orgs/:slug/reopen` (`period_date`, `reason`) |
| `update_org` | `PATCH /orgs/:slug` |
| `update_me` | `PATCH /me` |
| `decide_escalation` | *(no REST)* |
| `create_project` | `POST /projects` |
| `create_task` | `POST /projects/:id/tasks` |
| `complete_task` | `PATCH /tasks/:id` (`status: done`) |
| `comment_on_task` | `POST /comments` |
| `post_project_update` | `POST /projects/:id/updates` |
| `generate_report` | `POST /reports/generated` (queued; runs after commit) |
| `clock_in` / `clock_out` | `POST /attendance/clock` |

## Report-drafting profile

A run token minted with `profile: "report"` and `report_id` (agent-runner `channel: "report"`) gets a catalogue with one tool, `report_data`, and the report playbook. See [REPORTS.md](./REPORTS.md).

Implementation: [`packages/api/src/agent-tools.js`](../packages/api/src/agent-tools.js) and [`packages/api/src/domain/`](../packages/api/src/domain/).

## Meeting profile (Meeting Assistant)

A run token minted with `{ profile: 'meeting', meeting_id }` (only the agent runner can mint one,
via `POST /agent/runs`) gets a catalogue with **profile `meeting`**. It is bound to that one meeting,
and the meeting must be visible to the run's membership:

| Action | Args | Returns |
|---|---|---|
| `meeting_context` | none | title, agenda, organisation, host, people (name, title, host, attended) |
| `meeting_transcript` | none | `[mm:ss] Speaker: words` lines: the whole meeting, the part named by the token's `transcript_part`, or the latest part of a long meeting |

It also gets these safe reads: `show_me`, `find_person`, `list_kpis`, `show_kpi`, `list_off_track`.
There are no write tools: the summary is the agent's reply, which the API parses (docs/MEETINGS.md).
On an ordinary token, both meeting actions return `forbidden`.

## Meetings (normal catalogue)

| Action | Args | Returns |
|---|---|---|
| `list_meetings` | `from`, `to` (YYYY-MM-DD, optional; default two weeks either side of today) | title, when, status, organisation, host, attended count, `notes_ready` |
| `meeting_notes` | `title` (words from the title), `date` (YYYY-MM-DD); both optional | the most recent matching ended meeting: who attended, summary, decisions, action items (owner, due, status), plus other matches |

Both only see meetings the caller can see (RLS: owner all; others their org's, hosted, or invited).
`meeting_notes` is also on the Meeting Assistant's `meeting` catalogue (for "what did we decide last time?").
