# Portfolio OS — HTTP API ↔ agent tools

All tools are invoked with `POST /agent/tools/portfolio_os` and body `{ "action": "<name>", ... }`.

**Catalogue (for agent runtimes):** `GET /agent/tools/catalog` returns `playbook`, and per-tool `summary` + `allowed` for the caller. ADK loads this each turn (see `adk_new` `run_portfolio_turn`). Do not hardcode Portfolio actions in ADK. See [AGENTS.md](../AGENTS.md).

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
| `amend_number` | `PATCH /submissions/:id` |
| `withdraw_submission` | `DELETE /submissions/:id` |
| `validate_submission` | `POST /submissions/:id/validate` |
| `lock_day` | `POST /orgs/:slug/signoff` |
| `update_org` | `PATCH /orgs/:slug` |
| `update_me` | `PATCH /me` |
| `decide_escalation` | *(no REST)* |

Implementation: [`packages/api/src/agent-tools.js`](../packages/api/src/agent-tools.js) and [`packages/api/src/domain/`](../packages/api/src/domain/).
