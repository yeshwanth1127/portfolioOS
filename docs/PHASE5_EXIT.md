# Phase 5 exit gate — Projects & My Work

Spec: [BUILD.md §9](./BUILD.md#9-phase-5--projects--my-work) · Roadmap: [ROADMAP.md § Phase 5](./ROADMAP.md#phase-5--projects--my-work)

**Exit gate (full phase):** a pilot team runs a real project in the product, with WhatsApp updates and reminders (Sona pilot sign-off).

## Slice 5.0 — foundation

- [x] Migration `016_projects_tasks.sql`: `projects`, `tasks`; `assignments.project_id` FK; workspace RLS.
- [x] Migration `015_audit_log.sql` (Phase 4 close): permission denials audited.
- [x] API: `GET/POST /projects`, `GET/PATCH /projects/:id`, `GET/POST /projects/:id/tasks`, `PATCH /tasks/:id`, `GET /my-work`.
- [x] `can()`: `project.edit`, `task.assign` in `docs/permissions.csv` + `matrix.js`.
- [x] Agent tools: `list_projects`, `create_project`, `list_tasks`, `create_task`, `my_tasks` on catalogue.
- [x] Web: `/projects` list page; sidebar link.
- [x] Tests: `tests/integration/projects.test.js`, `permission-audit.test.js`.

## Slice 5.1 — My Work & notifications

- [x] Migration `017_milestones_notifications.sql`: `milestones`, `project_units`, `notifications`.
- [x] `/my-work` page (assignments, due ordering, quick complete); sidebar link.
- [x] Job queue in-app notifications (`task_notify`: assigned, due tomorrow, overdue).
- [x] Calendar feed: task due dates and milestones.
- [x] Overview **Delivery** card; `GET /my-work` milestones + approvals for reviewers.
- [x] Tests: `tests/integration/my-work.test.js`.

## Slice 5.2 — collaboration, agent & WA

- [x] Migration `018_projects_activity.sql`: `comments`, `project_updates`, `activity_log`, project health override fields, `tasks.milestone_id` + milestone/project trigger.
- [x] API: milestone CRUD (`GET/POST /projects/:id/milestones`, `PATCH /milestones/:id`); comments; project updates; activity feed; calculated + override health on `GET /projects/:id`.
- [x] `task_notify` job: in-app + `wa_outbox` (`kind=task_notify`) + optional `notifications.channel=whatsapp` row when assignee has `phone_e164`.
- [x] Agent tools: `complete_task`, `comment_on_task`, `post_project_update` (`tool-matrix.js`, catalogue, dispatch).
- [x] WA gateway: delivery phrase detection (`isDeliveryIntent`) → agent turn (permissions via `portfolio_os`); smoke in `tests/integration/whatsapp.test.js`.
- [x] Web: `/projects/[id]` (Overview · Tasks + side panel · Milestones); list links to detail.
- [x] Tests: `tests/integration/projects-52.test.js`.

### Production-only (not required for local gate)

- [ ] **Live WhatsApp task reminder rehearsal:** confirm `wa-gateway` drains `wa_outbox` (`task_notify`) to a real handset on production connector (calendar reminder pattern already proven in Phase 2).
- [ ] **Reminder copy polish** on production WA connector (tone, truncation, deep links if any).
- [ ] **Sona pilot:** one real project end-to-end with WhatsApp updates and reminders.
- [ ] **Product sign-off** on project health display, My Work, and notification copy.

## Phase 5 gate-ready (local)

| Check | Command / artefact |
|-------|-------------------|
| Migrations through `018` | `tests/integration/migrations.test.js` |
| Projects + agent 5.2 | `tests/integration/projects-52.test.js` |
| Full suite | `npm test` |
| Web build | `npm run build -w @portfolio-os/web` |

## Files touched (5.2)

| Area | Paths |
|------|--------|
| Schema | `packages/db/migrations/018_projects_activity.sql`, `verify/018_projects_activity.sql` |
| API | `packages/api/src/modules/projects.js`, `routes.js`, `agent-tools.js`, `agent-tool-schemas.js`, `core/permissions/tool-matrix.js` |
| WA | `services/wa-gateway/src/app.js` |
| Web | `apps/web/app/projects/page.js`, `apps/web/app/projects/[id]/page.js`, `apps/web/app/my-work/page.js` |
| Tests | `tests/integration/projects-52.test.js`, `tests/integration/whatsapp.test.js` |
| Docs | this file, `docs/ROADMAP.md`, `docs/agent-tools.md` |

## Full exit gate (production)

- [ ] Sona pilot team runs one real project end-to-end with WhatsApp reminders.
- [ ] Product sign-off on project health, My Work, and notification copy.
