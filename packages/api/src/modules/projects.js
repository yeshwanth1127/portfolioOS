import { addDays, todayIn } from '../core/dates.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { dbQuery } from '../domain/db-helpers.js';
import { noteWaMessage } from './commercial/usage.js';
import { cancelQueued, enqueue, registerJob } from '../jobs/queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_STATUS = new Set(['planned', 'active', 'on_hold', 'done', 'cancelled']);
const TASK_STATUS = new Set(['todo', 'in_progress', 'in_review', 'done', 'cancelled']);
const PRIORITY = new Set(['low', 'normal', 'high', 'urgent']);
const err = (code, message) => ({ error: { code, message } });

async function loadUnit(client, unitId) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, legacy_org_id, type, name FROM units WHERE id = $1`,
    [unitId],
  );
  return rows[0] ?? null;
}

async function loadProject(client, projectId) {
  const { rows } = await dbQuery(
    client,
    `SELECT p.id, p.unit_id, p.name, p.description, p.manager_id, p.status, p.priority,
            p.starts_on, p.due_on, p.created_at, p.updated_at,
            p.health_override, p.health_reason, p.health_set_by, p.health_set_at,
            u.legacy_org_id AS unit_org_id, u.name AS unit_name
     FROM projects p
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE p.id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function logActivity(client, membership, { projectId = null, taskId = null, kind, payload = {} }) {
  await client.query(
    `INSERT INTO activity_log (actor_id, project_id, task_id, kind, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [membership.id, projectId, taskId, kind, JSON.stringify(payload)],
  );
}

const MILESTONE_STATUS = new Set(['open', 'done', 'cancelled']);
const HEALTH_VALUES = new Set(['on_track', 'at_risk', 'off_track']);

async function computedHealth(client, projectId, tz = 'Asia/Kolkata') {
  const today = todayIn(tz);
  const { rows } = await dbQuery(
    client,
    `SELECT
       EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.project_id = $1 AND t.status NOT IN ('done','cancelled')
           AND t.due_on IS NOT NULL AND t.due_on < $2::date
       ) AS overdue_tasks,
       EXISTS (
         SELECT 1 FROM milestones m
         WHERE m.project_id = $1 AND m.status = 'open'
           AND m.due_on IS NOT NULL AND m.due_on < $2::date
       ) AS overdue_milestones`,
    [projectId, today],
  );
  const r = rows[0] ?? {};
  if (r.overdue_tasks || r.overdue_milestones) return 'at_risk';
  return 'on_track';
}

async function healthView(client, project, tz) {
  const calculated = await computedHealth(client, project.id, tz);
  return {
    calculated,
    override: project.health_override ?? null,
    reason: project.health_reason ?? null,
    set_at: project.health_set_at ?? null,
    display: project.health_override ?? calculated,
  };
}

function assertCanComment(membership, task, project) {
  const isAssignee = task?.assignee_id === membership.id;
  const isManager = project.manager_id === membership.id;
  if (isAssignee || isManager) return null;
  if (can(membership, 'project.edit', projectResource(project, membership))) return null;
  if (can(membership, 'task.assign', projectResource(project, membership))) return null;
  return permissionDenied(membership, 'project.edit');
}

async function loadTask(client, taskId) {
  const { rows } = await dbQuery(
    client,
    `SELECT t.*, p.manager_id AS project_manager_id, u.legacy_org_id AS unit_org_id
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE t.id = $1`,
    [taskId],
  );
  return rows[0] ?? null;
}

function projectResource(project, membership) {
  return {
    isProjectManager: project.manager_id === membership.id,
    unitOrgId: project.unit_org_id ?? null,
  };
}

function taskResource(task, membership) {
  return {
    isProjectManager: task.project_manager_id === membership.id,
    unitOrgId: task.unit_org_id ?? null,
  };
}

function assertCanCreateProject(membership, unit) {
  if (!can(membership, 'project.edit', { unitOrgId: unit?.legacy_org_id ?? null })) {
    return permissionDenied(membership, 'project.edit');
  }
  return null;
}

function assertCanEditProject(membership, project) {
  if (!can(membership, 'project.edit', projectResource(project, membership))) {
    return permissionDenied(membership, 'project.edit');
  }
  return null;
}

function assertCanAssignTasks(membership, project) {
  if (!can(membership, 'task.assign', projectResource(project, membership))) {
    return permissionDenied(membership, 'task.assign');
  }
  return null;
}

export async function listProjects(client, membership) {
  const { rows } = await dbQuery(
    client,
    `SELECT p.id, p.name, p.status, p.priority, p.due_on, p.manager_id,
            u.name AS unit_name,
            auth.workspace_member_name(p.manager_id) AS manager_name,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks
     FROM projects p
     JOIN units u ON u.id = p.unit_id
     ORDER BY lower(p.name), p.created_at`,
  );
  return { projects: rows };
}

export async function getProject(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const { rows: tasks } = await dbQuery(
    client,
    `SELECT t.id, t.title, t.status, t.priority, t.due_on, t.assignee_id, t.description, t.milestone_id,
            auth.workspace_member_name(t.assignee_id) AS assignee_name
     FROM tasks t
     WHERE t.project_id = $1
     ORDER BY t.position, t.created_at`,
    [projectId],
  );
  const { rows: milestones } = await dbQuery(
    client,
    `SELECT m.id, m.name, m.due_on, m.status, m.owner_id,
            auth.workspace_member_name(m.owner_id) AS owner_name
     FROM milestones m
     WHERE m.project_id = $1
     ORDER BY m.due_on NULLS LAST, m.created_at`,
    [projectId],
  );
  const { rows: updates } = await dbQuery(
    client,
    `SELECT u.id, u.body, u.created_at, u.author_id,
            auth.workspace_member_name(u.author_id) AS author_name
     FROM project_updates u
     WHERE u.project_id = $1
     ORDER BY u.created_at DESC
     LIMIT 10`,
    [projectId],
  );
  return {
    project: {
      ...project,
      manager_name: (
        await dbQuery(client, `SELECT auth.workspace_member_name($1) AS n`, [project.manager_id])
      ).rows[0]?.n,
      health: await healthView(client, project, tz),
      tasks,
      milestones,
      recent_updates: updates,
    },
  };
}

export async function createProject(client, membership, body) {
  const name = String(body?.name ?? '').trim();
  if (!name) return err('invalid', 'Give the project a name.');
  const unitId = body?.unit_id;
  if (!unitId || !UUID.test(String(unitId))) return err('invalid', 'Choose a unit for this project.');
  const unit = await loadUnit(client, unitId);
  if (!unit) return err('not_found', 'Unit not found.');
  const denied = assertCanCreateProject(membership, unit);
  if (denied) return denied;

  let managerId = body?.manager_id;
  if (managerId != null && !UUID.test(String(managerId))) return err('invalid', 'Unknown project manager.');
  if (!managerId) managerId = membership.id;

  const status = body?.status ?? 'planned';
  if (!PROJECT_STATUS.has(status)) return err('invalid', 'Unknown project status.');
  const priority = body?.priority ?? 'normal';
  if (!PRIORITY.has(priority)) return err('invalid', 'Unknown priority.');

  const { rows } = await dbQuery(
    client,
    `INSERT INTO projects (unit_id, name, description, manager_id, status, priority, starts_on, due_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, status, priority, due_on, manager_id, unit_id, created_at`,
    [
      unitId,
      name.slice(0, 200),
      body?.description ? String(body.description).trim().slice(0, 4000) : null,
      managerId,
      status,
      priority,
      body?.starts_on ?? null,
      body?.due_on ?? null,
    ],
  );
  const project = rows[0];
  await logActivity(client, membership, {
    projectId: project.id,
    kind: 'project.created',
    payload: { name: project.name, status: project.status },
  });
  return { project };
}

export async function updateProject(client, membership, projectId, body) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const denied = assertCanEditProject(membership, project);
  if (denied) return denied;

  const fields = [];
  const params = [projectId];
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return err('invalid', 'Give the project a name.');
    params.push(name.slice(0, 200));
    fields.push(`name = $${params.length}`);
  }
  if (body?.description !== undefined) {
    params.push(body.description ? String(body.description).trim().slice(0, 4000) : null);
    fields.push(`description = $${params.length}`);
  }
  if (body?.status !== undefined) {
    if (!PROJECT_STATUS.has(body.status)) return err('invalid', 'Unknown project status.');
    params.push(body.status);
    fields.push(`status = $${params.length}`);
  }
  if (body?.priority !== undefined) {
    if (!PRIORITY.has(body.priority)) return err('invalid', 'Unknown priority.');
    params.push(body.priority);
    fields.push(`priority = $${params.length}`);
  }
  if (body?.starts_on !== undefined) {
    params.push(body.starts_on || null);
    fields.push(`starts_on = $${params.length}`);
  }
  if (body?.due_on !== undefined) {
    params.push(body.due_on || null);
    fields.push(`due_on = $${params.length}`);
  }
  if (body?.manager_id !== undefined) {
    if (!UUID.test(String(body.manager_id))) return err('invalid', 'Unknown project manager.');
    params.push(body.manager_id);
    fields.push(`manager_id = $${params.length}`);
  }
  if (body?.health_override !== undefined) {
    const ho = body.health_override;
    if (ho != null && !HEALTH_VALUES.has(ho)) return err('invalid', 'Unknown health override.');
    const reason = body?.health_reason != null ? String(body.health_reason).trim().slice(0, 500) : null;
    if (ho && !reason) return err('invalid', 'Give a reason for the health override.');
    if (ho == null) {
      fields.push('health_override = NULL', 'health_reason = NULL', 'health_set_by = NULL', 'health_set_at = NULL');
    } else {
      params.push(ho, reason, membership.id);
      fields.push(`health_override = $${params.length - 2}`);
      fields.push(`health_reason = $${params.length - 1}`);
      fields.push(`health_set_by = $${params.length}`);
      fields.push(`health_set_at = now()`);
    }
  } else if (body?.health_reason !== undefined) {
    return err('invalid', 'Set health_override together with health_reason.');
  }
  if (!fields.length) return err('invalid', 'Nothing to update.');
  fields.push('updated_at = now()');

  const { rows } = await dbQuery(
    client,
    `UPDATE projects SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, name, status, priority, due_on, manager_id, unit_id, updated_at,
               health_override, health_reason, health_set_by, health_set_at`,
    params,
  );
  const updated = rows[0];
  await logActivity(client, membership, {
    projectId: updated.id,
    kind: 'project.updated',
    payload: { fields: Object.keys(body ?? {}) },
  });
  return { project: updated };
}

export async function listTasks(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const { rows } = await dbQuery(
    client,
    `SELECT t.id, t.title, t.status, t.priority, t.due_on, t.assignee_id, t.position,
            auth.workspace_member_name(t.assignee_id) AS assignee_name
     FROM tasks t
     WHERE t.project_id = $1
     ORDER BY t.position, t.created_at`,
    [projectId],
  );
  return { project_id: projectId, tasks: rows };
}

export async function createTask(client, membership, projectId, body) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const denied = assertCanAssignTasks(membership, project);
  if (denied) return denied;

  const title = String(body?.title ?? '').trim();
  if (!title) return err('invalid', 'Give the task a title.');
  const status = body?.status ?? 'todo';
  if (!TASK_STATUS.has(status)) return err('invalid', 'Unknown task status.');
  const priority = body?.priority ?? 'normal';
  if (!PRIORITY.has(priority)) return err('invalid', 'Unknown priority.');

  let assigneeId = body?.assignee_id ?? null;
  if (assigneeId != null && !UUID.test(String(assigneeId))) return err('invalid', 'Unknown assignee.');

  const { rows: posRows } = await dbQuery(
    client,
    `SELECT coalesce(max(position), 0) + 1 AS next FROM tasks WHERE project_id = $1`,
    [projectId],
  );
  const position = posRows[0]?.next ?? 1;

  const { rows } = await dbQuery(
    client,
    `INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_on, position, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, project_id, title, status, priority, due_on, assignee_id, position, created_at`,
    [
      projectId,
      title.slice(0, 300),
      body?.description ? String(body.description).trim().slice(0, 4000) : null,
      assigneeId,
      status,
      priority,
      body?.due_on ?? null,
      position,
      membership.id,
    ],
  );
  const task = rows[0];
  await logActivity(client, membership, {
    projectId,
    taskId: task.id,
    kind: 'task.created',
    payload: { title: task.title, assignee_id: assigneeId },
  });
  await scheduleTaskNotificationJobs(client, task, { notifyAssign: Boolean(assigneeId) });
  if (assigneeId) {
    await enqueue(client, 'task_notify', { task_id: task.id, kind: 'assigned' }, {
      dedupeKey: `task:${task.id}:assigned:${assigneeId}`,
    });
  }
  return { task };
}

export async function updateTask(client, membership, taskId, body) {
  if (!UUID.test(String(taskId))) return err('not_found', 'Task not found.');
  const task = await loadTask(client, taskId);
  if (!task) return err('not_found', 'Task not found.');

  const isAssignee = task.assignee_id === membership.id;
  const needsAssign = body?.assignee_id !== undefined;
  const needsEdit =
    body?.title !== undefined ||
    body?.description !== undefined ||
    body?.priority !== undefined ||
    body?.due_on !== undefined ||
    body?.status !== undefined ||
    body?.estimate_hours !== undefined;

  if (needsAssign) {
    const denied = assertCanAssignTasks(membership, task);
    if (denied) return denied;
  } else if (needsEdit && !isAssignee) {
    const denied = assertCanEditProject(membership, task);
    if (denied) return denied;
  } else if (needsEdit && isAssignee && body?.status === undefined && body?.due_on === undefined) {
    return permissionDenied(membership, 'project.edit');
  }

  const fields = [];
  const params = [taskId];
  if (body?.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return err('invalid', 'Give the task a title.');
    params.push(title.slice(0, 300));
    fields.push(`title = $${params.length}`);
  }
  if (body?.description !== undefined) {
    params.push(body.description ? String(body.description).trim().slice(0, 4000) : null);
    fields.push(`description = $${params.length}`);
  }
  if (body?.status !== undefined) {
    if (!TASK_STATUS.has(body.status)) return err('invalid', 'Unknown task status.');
    params.push(body.status);
    fields.push(`status = $${params.length}`);
    if (body.status === 'done') {
      fields.push(`completed_at = now()`);
    } else {
      fields.push(`completed_at = NULL`);
    }
  }
  if (body?.priority !== undefined) {
    if (!PRIORITY.has(body.priority)) return err('invalid', 'Unknown priority.');
    params.push(body.priority);
    fields.push(`priority = $${params.length}`);
  }
  if (body?.due_on !== undefined) {
    params.push(body.due_on || null);
    fields.push(`due_on = $${params.length}`);
  }
  if (body?.assignee_id !== undefined) {
    if (body.assignee_id != null && !UUID.test(String(body.assignee_id))) return err('invalid', 'Unknown assignee.');
    params.push(body.assignee_id ?? null);
    fields.push(`assignee_id = $${params.length}`);
  }
  if (body?.estimate_hours !== undefined) {
    const est = body.estimate_hours == null ? null : Number(body.estimate_hours);
    if (est != null && (!Number.isFinite(est) || est < 0)) return err('invalid', 'estimate_hours must be non-negative.');
    params.push(est);
    fields.push(`estimate_hours = $${params.length}`);
  }
  if (!fields.length) return err('invalid', 'Nothing to update.');
  fields.push('updated_at = now()');

  const assigneeChanged = body?.assignee_id !== undefined && body.assignee_id !== task.assignee_id;
  const { rows } = await dbQuery(
    client,
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, project_id, title, status, priority, due_on, assignee_id, position, updated_at`,
    params,
  );
  const updated = rows[0];
  const activityKind = body?.status === 'done' ? 'task.completed' : 'task.updated';
  await logActivity(client, membership, {
    projectId: updated.project_id,
    taskId: updated.id,
    kind: activityKind,
    payload: { status: updated.status },
  });
  await scheduleTaskNotificationJobs(client, updated);
  if (assigneeChanged && updated.assignee_id) {
    await enqueue(client, 'task_notify', { task_id: updated.id, kind: 'assigned' }, {
      dedupeKey: `task:${updated.id}:assigned:${updated.assignee_id}`,
    });
  }
  return { task: updated };
}

export async function completeTask(client, membership, taskId) {
  return updateTask(client, membership, taskId, { status: 'done' });
}

async function dayStartInTz(client, isoDate, tz) {
  const { rows } = await client.query(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS t`, [isoDate, tz]);
  return rows[0]?.t ?? new Date();
}

async function scheduleTaskNotificationJobs(client, task, { tz = 'Asia/Kolkata' } = {}) {
  await cancelQueued(client, `task:${task.id}:`);
  if (!task.assignee_id || ['done', 'cancelled'].includes(task.status)) return;
  if (!task.due_on) return;
  const dueTomorrow = addDays(task.due_on, -1);
  const overdueDay = addDays(task.due_on, 1);
  const tomorrowAt = await dayStartInTz(client, dueTomorrow, tz);
  const overdueAt = await dayStartInTz(client, overdueDay, tz);
  if (tomorrowAt > new Date()) {
    await enqueue(
      client,
      'task_notify',
      { task_id: task.id, kind: 'due_tomorrow' },
      { runAt: tomorrowAt, dedupeKey: `task:${task.id}:due_tomorrow` },
    );
  }
  if (overdueAt > new Date()) {
    await enqueue(
      client,
      'task_notify',
      { task_id: task.id, kind: 'overdue' },
      { runAt: overdueAt, dedupeKey: `task:${task.id}:overdue` },
    );
  }
}

async function insertTaskNotification(client, { membershipId, kind, taskId, projectId, body }) {
  await client.query(
    `INSERT INTO notifications (membership_id, kind, task_id, project_id, body, channel)
     VALUES ($1, $2, $3, $4, $5, 'in_app')`,
    [membershipId, kind, taskId, projectId, body.slice(0, 500)],
  );
}

async function enqueueTaskWhatsApp(client, membershipId, body, { taskId, projectId, kind }) {
  const { rows } = await client.query(
    `SELECT u.phone_e164 FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.id = $1 AND u.phone_e164 IS NOT NULL AND trim(u.phone_e164) <> ''`,
    [membershipId],
  );
  const phone = rows[0]?.phone_e164;
  if (!phone) return;
  await client.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1, $2, 'task_notify')`, [
    phone,
    body.slice(0, 500),
  ]);
  const { rows: wsRow } = await client.query(`SELECT id, timezone FROM workspaces WHERE id = app_workspace()`);
  if (wsRow[0]) await noteWaMessage(wsRow[0].id, wsRow[0].timezone);
  await client.query(
    `INSERT INTO notifications (membership_id, kind, task_id, project_id, body, channel)
     VALUES ($1, $2, $3, $4, $5, 'whatsapp')`,
    [membershipId, kind, taskId, projectId, body.slice(0, 500)],
  );
}

registerJob('task_notify', async (client, payload) => {
  const taskId = payload.task_id;
  const kind = payload.kind;
  if (!taskId || !kind) return;
  const { rows } = await client.query(
    `SELECT t.id, t.title, t.status, t.due_on, t.assignee_id, t.project_id, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     WHERE t.id = $1`,
    [taskId],
  );
  const task = rows[0];
  if (!task || !task.assignee_id || ['done', 'cancelled'].includes(task.status)) return;

  const today = todayIn();
  let body;
  if (kind === 'assigned') {
    body = `Assigned: ${task.title} · ${task.project_name}`;
  } else if (kind === 'due_tomorrow') {
    if (task.due_on !== addDays(today, 1)) return;
    body = `Due tomorrow: ${task.title} · ${task.project_name}`;
  } else if (kind === 'overdue') {
    if (!task.due_on || task.due_on >= today) return;
    body = `Overdue: ${task.title} · ${task.project_name}`;
  } else {
    return;
  }
  const notifyKind = `task_${kind}`;
  await insertTaskNotification(client, {
    membershipId: task.assignee_id,
    kind: notifyKind,
    taskId: task.id,
    projectId: task.project_id,
    body,
  });
  await enqueueTaskWhatsApp(client, task.assignee_id, body, {
    taskId: task.id,
    projectId: task.project_id,
    kind: notifyKind,
  });
});

export async function listMilestones(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const { rows } = await dbQuery(
    client,
    `SELECT m.id, m.name, m.due_on, m.status, m.owner_id, m.completed_at,
            auth.workspace_member_name(m.owner_id) AS owner_name
     FROM milestones m
     WHERE m.project_id = $1
     ORDER BY m.due_on NULLS LAST, m.created_at`,
    [projectId],
  );
  return { project_id: projectId, milestones: rows };
}

export async function createMilestone(client, membership, projectId, body) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const denied = assertCanEditProject(membership, project);
  if (denied) return denied;
  const name = String(body?.name ?? '').trim();
  if (!name) return err('invalid', 'Give the milestone a name.');
  let ownerId = body?.owner_id ?? project.manager_id;
  if (ownerId != null && !UUID.test(String(ownerId))) return err('invalid', 'Unknown milestone owner.');
  const { rows } = await dbQuery(
    client,
    `INSERT INTO milestones (project_id, name, due_on, owner_id, status)
     VALUES ($1,$2,$3,$4,'open')
     RETURNING id, project_id, name, due_on, owner_id, status, created_at`,
    [projectId, name.slice(0, 200), body?.due_on ?? null, ownerId],
  );
  const milestone = rows[0];
  await logActivity(client, membership, {
    projectId,
    kind: 'milestone.created',
    payload: { milestone_id: milestone.id, name: milestone.name },
  });
  return { milestone };
}

export async function updateMilestone(client, membership, milestoneId, body) {
  if (!UUID.test(String(milestoneId))) return err('not_found', 'Milestone not found.');
  const { rows: found } = await dbQuery(
    client,
    `SELECT m.*, p.manager_id AS project_manager_id, u.legacy_org_id AS unit_org_id
     FROM milestones m
     JOIN projects p ON p.id = m.project_id AND p.workspace_id = m.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE m.id = $1`,
    [milestoneId],
  );
  const milestone = found[0];
  if (!milestone) return err('not_found', 'Milestone not found.');
  const project = {
    id: milestone.project_id,
    manager_id: milestone.project_manager_id,
    unit_org_id: milestone.unit_org_id,
  };
  const isOwner = milestone.owner_id === membership.id;
  if (!isOwner) {
    const denied = assertCanEditProject(membership, project);
    if (denied) return denied;
  }
  const fields = [];
  const params = [milestoneId];
  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return err('invalid', 'Give the milestone a name.');
    params.push(name.slice(0, 200));
    fields.push(`name = $${params.length}`);
  }
  if (body?.due_on !== undefined) {
    params.push(body.due_on || null);
    fields.push(`due_on = $${params.length}`);
  }
  if (body?.owner_id !== undefined) {
    if (body.owner_id != null && !UUID.test(String(body.owner_id))) return err('invalid', 'Unknown owner.');
    params.push(body.owner_id ?? null);
    fields.push(`owner_id = $${params.length}`);
  }
  if (body?.status !== undefined) {
    if (!MILESTONE_STATUS.has(body.status)) return err('invalid', 'Unknown milestone status.');
    params.push(body.status);
    fields.push(`status = $${params.length}`);
    if (body.status === 'done') {
      fields.push(`completed_at = now()`);
    } else if (body.status === 'open') {
      fields.push('completed_at = NULL');
    }
  }
  if (!fields.length) return err('invalid', 'Nothing to update.');
  fields.push('updated_at = now()');
  const { rows } = await dbQuery(
    client,
    `UPDATE milestones SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, project_id, name, due_on, owner_id, status, completed_at, updated_at`,
    params,
  );
  const updated = rows[0];
  await logActivity(client, membership, {
    projectId: updated.project_id,
    kind: 'milestone.updated',
    payload: { milestone_id: updated.id, status: updated.status },
  });
  return { milestone: updated };
}

export async function listComments(client, membership, query) {
  const { task_id: taskId, project_id: projectId, milestone_id: milestoneId } = query ?? {};
  const set = [taskId, projectId, milestoneId].filter(Boolean);
  if (set.length !== 1) return err('invalid', 'Pass exactly one of task_id, project_id, or milestone_id.');
  let where = '';
  const params = [];
  if (taskId) {
    if (!UUID.test(String(taskId))) return err('not_found', 'Task not found.');
    params.push(taskId);
    where = 'c.task_id = $1';
  } else if (projectId) {
    if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
    params.push(projectId);
    where = 'c.project_id = $1';
  } else {
    if (!UUID.test(String(milestoneId))) return err('not_found', 'Milestone not found.');
    params.push(milestoneId);
    where = 'c.milestone_id = $1';
  }
  const { rows } = await dbQuery(
    client,
    `SELECT c.id, c.body, c.created_at, c.author_id,
            auth.workspace_member_name(c.author_id) AS author_name
     FROM comments c
     WHERE ${where}
     ORDER BY c.created_at`,
    params,
  );
  return { comments: rows };
}

export async function createComment(client, membership, body) {
  const text = String(body?.body ?? '').trim();
  if (!text) return err('invalid', 'Write a comment.');
  let projectId = null;
  let taskId = body?.task_id ?? null;
  let milestoneId = body?.milestone_id ?? null;
  if (body?.project_id) projectId = body.project_id;
  const targets = [projectId, taskId, milestoneId].filter(Boolean);
  if (targets.length !== 1) return err('invalid', 'Comment on exactly one of project_id, task_id, or milestone_id.');

  if (taskId) {
    if (!UUID.test(String(taskId))) return err('not_found', 'Task not found.');
    const task = await loadTask(client, taskId);
    if (!task) return err('not_found', 'Task not found.');
    const project = await loadProject(client, task.project_id);
    const denied = assertCanComment(membership, task, project);
    if (denied) return denied;
    projectId = task.project_id;
  } else if (milestoneId) {
    if (!UUID.test(String(milestoneId))) return err('not_found', 'Milestone not found.');
    const { rows } = await dbQuery(
      client,
      `SELECT m.project_id, p.manager_id, u.legacy_org_id AS unit_org_id
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       JOIN units u ON u.id = p.unit_id
       WHERE m.id = $1`,
      [milestoneId],
    );
    if (!rows[0]) return err('not_found', 'Milestone not found.');
    const denied = assertCanEditProject(membership, rows[0]);
    if (denied) return denied;
    projectId = rows[0].project_id;
  } else {
    if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
    const project = await loadProject(client, projectId);
    if (!project) return err('not_found', 'Project not found.');
    const denied = assertCanEditProject(membership, project);
    if (denied) return denied;
  }

  const cols = projectId && !taskId && !milestoneId ? 'project_id' : taskId ? 'task_id' : 'milestone_id';
  const val = projectId && !taskId && !milestoneId ? projectId : taskId ?? milestoneId;
  const { rows } = await dbQuery(
    client,
    `INSERT INTO comments (${cols}, body, author_id)
     VALUES ($1, $2, $3)
     RETURNING id, ${cols} AS anchor_id, body, author_id, created_at`,
    [val, text.slice(0, 4000), membership.id],
  );
  const comment = rows[0];
  await logActivity(client, membership, {
    projectId: projectId ?? undefined,
    taskId: taskId ?? undefined,
    kind: 'comment.added',
    payload: { comment_id: comment.id },
  });
  return { comment };
}

export async function commentOnTask(client, membership, body) {
  return createComment(client, membership, { task_id: body?.task_id, body: body?.body });
}

export async function postProjectUpdate(client, membership, projectId, body) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const denied = assertCanEditProject(membership, project);
  if (denied) return denied;
  const text = String(body?.body ?? '').trim();
  if (!text) return err('invalid', 'Write an update.');
  const { rows } = await dbQuery(
    client,
    `INSERT INTO project_updates (project_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, body, author_id, created_at`,
    [projectId, membership.id, text.slice(0, 2000)],
  );
  const update = rows[0];
  await logActivity(client, membership, {
    projectId,
    kind: 'project_update.posted',
    payload: { update_id: update.id },
  });
  return { update };
}

export async function listProjectUpdates(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const { rows } = await dbQuery(
    client,
    `SELECT u.id, u.body, u.created_at, u.author_id,
            auth.workspace_member_name(u.author_id) AS author_name
     FROM project_updates u
     WHERE u.project_id = $1
     ORDER BY u.created_at DESC`,
    [projectId],
  );
  return { project_id: projectId, updates: rows };
}

export async function listProjectActivity(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProject(client, projectId);
  if (!project) return err('not_found', 'Project not found.');
  const { rows } = await dbQuery(
    client,
    `SELECT a.id, a.kind, a.payload, a.at, a.task_id, a.actor_id,
            auth.workspace_member_name(a.actor_id) AS actor_name
     FROM activity_log a
     WHERE a.project_id = $1
     ORDER BY a.at DESC
     LIMIT 50`,
    [projectId],
  );
  return { project_id: projectId, activity: rows };
}

export async function myWork(client, membership) {
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const today = todayIn(tz);
  const horizon = addDays(today, 14);
  const { rows } = await dbQuery(
    client,
    `SELECT t.id, t.title, t.status, t.priority, t.due_on,
            p.id AS project_id, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     WHERE t.assignee_id = $1
       AND t.status NOT IN ('done', 'cancelled')
     ORDER BY t.due_on NULLS LAST, t.position, t.created_at`,
    [membership.id],
  );
  const { rows: milestones } = await dbQuery(
    client,
    `SELECT m.id, m.name, m.due_on, m.status,
            p.id AS project_id, p.name AS project_name
     FROM milestones m
     JOIN projects p ON p.id = m.project_id AND p.workspace_id = m.workspace_id
     WHERE m.owner_id = $1
       AND m.status = 'open'
       AND m.due_on IS NOT NULL
       AND m.due_on <= $2::date
     ORDER BY m.due_on, m.created_at`,
    [membership.id, horizon],
  );

  let approvals = [];
  if (can(membership, 'submission.approve')) {
    const orgFilter = membership.role === 'owner' ? '' : ' AND s.org_id = $1';
    const params = membership.role === 'owner' ? [] : [membership.org_id];
    const { rows: pending } = await dbQuery(
      client,
      `SELECT s.id, s.period_date, k.name AS kpi_name, o.short_name AS org
       FROM submissions s
       JOIN kpis k ON k.id = s.kpi_id
       JOIN organisations o ON o.id = s.org_id
       WHERE s.state = 'submitted'${orgFilter}
       ORDER BY s.period_date DESC, o.short_name
       LIMIT 20`,
      params,
    );
    approvals = pending;
  }

  return { today, tasks: rows, milestones, approvals };
}
