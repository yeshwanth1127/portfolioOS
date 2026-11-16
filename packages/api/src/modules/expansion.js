import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { dbQuery } from '../domain/db-helpers.js';
import { createProject, createTask } from './projects.js';
import { enqueue, registerJob } from '../jobs/queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES = new Set(['task', 'project']);
const CALENDAR_PROVIDERS = new Set(['google', 'outlook']);
const err = (code, message) => ({ error: { code, message } });

function attachmentsDir() {
  return process.env.ATTACHMENTS_DIR ?? path.join(process.cwd(), '.data', 'attachments');
}

async function loadProjectBrief(client, projectId) {
  const { rows } = await dbQuery(
    client,
    `SELECT p.id, p.manager_id, u.legacy_org_id AS unit_org_id
     FROM projects p
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE p.id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function loadTaskBrief(client, taskId) {
  const { rows } = await dbQuery(
    client,
    `SELECT t.id, t.project_id, p.manager_id, u.legacy_org_id AS unit_org_id
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

function assertProjectEdit(membership, project) {
  if (!can(membership, 'project.edit', projectResource(project, membership))) {
    return permissionDenied(membership, 'project.edit');
  }
  return null;
}

function assertTaskAssign(membership, task) {
  if (!can(membership, 'task.assign', {
    isProjectManager: task.manager_id === membership.id,
    unitOrgId: task.unit_org_id ?? null,
  })) {
    return permissionDenied(membership, 'task.assign');
  }
  return null;
}

export async function addTaskDependency(client, membership, taskId, body) {
  if (!UUID.test(String(taskId))) return err('not_found', 'Task not found.');
  const task = await loadTaskBrief(client, taskId);
  if (!task) return err('not_found', 'Task not found.');
  const denied = assertTaskAssign(membership, task);
  if (denied) return denied;

  let predecessorId = body?.predecessor_id ?? null;
  let successorId = body?.successor_id ?? null;
  if (body?.other_task_id && body?.relation) {
    const other = String(body.other_task_id);
    if (!UUID.test(other)) return err('invalid', 'Unknown related task.');
    if (body.relation === 'predecessor') {
      predecessorId = other;
      successorId = taskId;
    } else if (body.relation === 'successor') {
      predecessorId = taskId;
      successorId = other;
    } else {
      return err('invalid', 'relation must be predecessor or successor.');
    }
  }
  if (!predecessorId || !successorId) {
    return err('invalid', 'predecessor_id and successor_id required (one must be this task).');
  }
  if (predecessorId !== taskId && successorId !== taskId) {
    return err('invalid', 'This task must be the predecessor or successor.');
  }

  const otherId = predecessorId === taskId ? successorId : predecessorId;
  const other = await loadTaskBrief(client, otherId);
  if (!other) return err('not_found', 'Related task not found.');
  if (other.project_id !== task.project_id) {
    return err('invalid', 'Dependencies must be within the same project.');
  }

  try {
    const { rows } = await dbQuery(
      client,
      `INSERT INTO task_dependencies (predecessor_id, successor_id)
       VALUES ($1, $2)
       RETURNING id, predecessor_id, successor_id, created_at`,
      [predecessorId, successorId],
    );
    return { dependency: rows[0] };
  } catch (e) {
    if (e.code === '23505') return err('conflict', 'That dependency already exists.');
    if (e.code === '23514' || e.code === 'P0001' || /dependency_cycle|check_violation/i.test(String(e.message))) {
      return err('conflict', 'Adding this dependency would create a cycle.');
    }
    throw e;
  }
}

export async function removeTaskDependency(client, membership, taskId, body) {
  if (!UUID.test(String(taskId))) return err('not_found', 'Task not found.');
  const task = await loadTaskBrief(client, taskId);
  if (!task) return err('not_found', 'Task not found.');
  const denied = assertTaskAssign(membership, task);
  if (denied) return denied;

  const predecessorId = body?.predecessor_id;
  const successorId = body?.successor_id;
  if (!UUID.test(String(predecessorId)) || !UUID.test(String(successorId))) {
    return err('invalid', 'predecessor_id and successor_id required.');
  }
  const { rowCount } = await client.query(
    `DELETE FROM task_dependencies
     WHERE predecessor_id = $1 AND successor_id = $2
       AND (predecessor_id = $3 OR successor_id = $3)`,
    [predecessorId, successorId, taskId],
  );
  if (!rowCount) return err('not_found', 'Dependency not found.');
  return { ok: true };
}

export async function projectDependencyGraph(client, membership, projectId) {
  if (!UUID.test(String(projectId))) return err('not_found', 'Project not found.');
  const project = await loadProjectBrief(client, projectId);
  if (!project) return err('not_found', 'Project not found.');

  const { rows: tasks } = await dbQuery(
    client,
    `SELECT t.id, t.title, t.status, t.due_on,
            (SELECT coalesce(jsonb_agg(td.predecessor_id), '[]'::jsonb)
             FROM task_dependencies td
             WHERE td.successor_id = t.id) AS blocked_by
     FROM tasks t
     WHERE t.project_id = $1
     ORDER BY t.position, t.created_at`,
    [projectId],
  );
  const { rows: edges } = await dbQuery(
    client,
    `SELECT td.predecessor_id, td.successor_id
     FROM task_dependencies td
     JOIN tasks t ON t.id = td.successor_id AND t.project_id = $1`,
    [projectId],
  );
  return {
    project_id: projectId,
    nodes: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      due_on: t.due_on,
      blocked_by: t.blocked_by ?? [],
    })),
    edges,
  };
}

export async function listProjectTemplates(client, membership) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, name, payload, created_at, updated_at FROM project_templates ORDER BY lower(name), created_at`,
  );
  return { templates: rows };
}

export async function createProjectTemplate(client, membership, body) {
  if (!can(membership, 'project.edit', { unitOrgId: membership.org_id })) {
    return permissionDenied(membership, 'project.edit');
  }
  const name = String(body?.name ?? '').trim();
  if (!name) return err('invalid', 'Template name required.');
  const payload = body?.payload ?? {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return err('invalid', 'payload must be an object.');
  const { rows } = await dbQuery(
    client,
    `INSERT INTO project_templates (name, payload) VALUES ($1, $2::jsonb)
     RETURNING id, name, payload, created_at`,
    [name.slice(0, 200), JSON.stringify(payload)],
  );
  return { template: rows[0] };
}

export async function instantiateProjectTemplate(client, membership, templateId, body) {
  if (!UUID.test(String(templateId))) return err('not_found', 'Template not found.');
  const { rows: templates } = await dbQuery(
    client,
    `SELECT id, name, payload FROM project_templates WHERE id = $1`,
    [templateId],
  );
  const template = templates[0];
  if (!template) return err('not_found', 'Template not found.');

  const unitId = body?.unit_id;
  if (!UUID.test(String(unitId))) return err('invalid', 'unit_id required.');
  const payload = template.payload ?? {};
  const projectBody = {
    name: String(body?.name ?? template.name).trim().slice(0, 200),
    unit_id: unitId,
    manager_id: body?.manager_id ?? membership.id,
    ...(payload.project ?? {}),
  };
  const created = await createProject(client, membership, projectBody);
  if (created.error) return created;
  const projectId = created.project.id;
  const taskSpecs = Array.isArray(payload.tasks) ? payload.tasks : [];
  const createdTasks = [];
  for (const spec of taskSpecs) {
    const title = String(spec?.title ?? '').trim();
    if (!title) continue;
    const taskOut = await createTask(client, membership, projectId, { ...spec, title });
    if (taskOut.task) createdTasks.push(taskOut.task);
  }
  return { project: created.project, tasks: createdTasks, template_id: templateId };
}

export async function createAttachment(client, membership, body) {
  const entityType = body?.entity_type;
  const entityId = body?.entity_id;
  if (!ENTITY_TYPES.has(entityType) || !UUID.test(String(entityId))) {
    return err('invalid', 'entity_type (task|project) and entity_id required.');
  }
  const fileName = String(body?.file_name ?? 'file').trim().slice(0, 255);
  const mime = String(body?.mime_type ?? body?.mime ?? 'application/octet-stream').slice(0, 120);
  const storageKey = String(body?.storage_key ?? crypto.randomUUID()).trim().slice(0, 500);
  const byteSize = Number(body?.byte_size ?? body?.size ?? 0);
  if (!Number.isFinite(byteSize) || byteSize < 0) return err('invalid', 'Invalid byte_size.');

  if (entityType === 'project') {
    const project = await loadProjectBrief(client, entityId);
    if (!project) return err('not_found', 'Project not found.');
    const denied = assertProjectEdit(membership, project);
    if (denied) return denied;
  } else {
    const task = await loadTaskBrief(client, entityId);
    if (!task) return err('not_found', 'Task not found.');
    const denied = assertTaskAssign(membership, task);
    if (denied) return denied;
  }

  const dir = attachmentsDir();
  await fs.mkdir(dir, { recursive: true });
  const relKey = storageKey.replace(/\.\./g, '').replace(/^\/+/, '');
  const diskPath = path.join(dir, relKey);
  const content = body?.content_base64
    ? Buffer.from(String(body.content_base64), 'base64')
    : Buffer.from(String(body?.content ?? ''), 'utf8');
  if (content.length) {
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, content);
  }

  const { rows } = await dbQuery(
    client,
    `INSERT INTO attachments (entity_type, entity_id, file_name, mime_type, storage_key, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, entity_type, entity_id, file_name, mime_type, storage_key, byte_size, created_at`,
    [entityType, entityId, fileName, mime, relKey, content.length || byteSize, membership.id],
  );
  return { attachment: rows[0] };
}

export async function getAttachment(client, membership, attachmentId) {
  if (!UUID.test(String(attachmentId))) return err('not_found', 'Attachment not found.');
  const { rows } = await dbQuery(
    client,
    `SELECT id, entity_type, entity_id, file_name, mime_type, storage_key, byte_size, created_at
     FROM attachments WHERE id = $1`,
    [attachmentId],
  );
  const row = rows[0];
  if (!row) return err('not_found', 'Attachment not found.');
  const diskPath = path.join(attachmentsDir(), row.storage_key);
  let content;
  try {
    content = await fs.readFile(diskPath);
  } catch {
    return err('not_found', 'Attachment file missing on disk.');
  }
  return {
    attachment: row,
    content_base64: content.toString('base64'),
    download_name: row.file_name,
    mime_type: row.mime_type,
  };
}

export async function listSavedViews(client, membership) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, name, route, filters, created_at, updated_at FROM saved_views
     WHERE user_id = $1 ORDER BY lower(name), created_at`,
    [membership.id],
  );
  return { views: rows };
}

export async function createSavedView(client, membership, body) {
  const name = String(body?.name ?? '').trim();
  const route = String(body?.route ?? '').trim();
  if (!name || !route) return err('invalid', 'name and route required.');
  const filters = body?.filters ?? {};
  if (typeof filters !== 'object' || Array.isArray(filters)) return err('invalid', 'filters must be an object.');
  const { rows } = await dbQuery(
    client,
    `INSERT INTO saved_views (user_id, name, route, filters)
     VALUES ($1,$2,$3,$4::jsonb)
     RETURNING id, name, route, filters, created_at`,
    [membership.id, name.slice(0, 120), route.slice(0, 200), JSON.stringify(filters)],
  );
  return { view: rows[0] };
}

export async function deleteSavedView(client, membership, viewId) {
  if (!UUID.test(String(viewId))) return err('not_found', 'View not found.');
  const { rowCount } = await client.query(
    `DELETE FROM saved_views WHERE id = $1 AND user_id = $2`,
    [viewId, membership.id],
  );
  if (!rowCount) return err('not_found', 'View not found.');
  return { ok: true };
}

export async function workloadByUnit(client, membership, unitId) {
  if (!UUID.test(String(unitId))) return err('invalid', 'unit_id required.');
  const { rows } = await dbQuery(
    client,
    `SELECT t.assignee_id,
            auth.workspace_member_name(t.assignee_id) AS assignee_name,
            count(*)::int AS open_tasks,
            coalesce(sum(t.estimate_hours), 0)::float AS estimate_hours
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     WHERE p.unit_id = $1 AND t.status NOT IN ('done','cancelled')
     GROUP BY t.assignee_id
     ORDER BY open_tasks DESC, assignee_name NULLS LAST`,
    [unitId],
  );
  return { unit_id: unitId, assignees: rows };
}

export async function connectCalendar(client, membership, body) {
  const provider = String(body?.provider ?? 'google').toLowerCase();
  if (!CALENDAR_PROVIDERS.has(provider)) return err('invalid', 'provider must be google or outlook.');
  if (membership.role !== 'owner') return err('forbidden', 'Workspace owner only.');
  const state = crypto.randomBytes(16).toString('hex');
  await client.query(
    `INSERT INTO calendar_integrations (provider, status, tokens)
     VALUES ($1::calendar_provider, 'pending', $2::jsonb)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       status = 'pending',
       tokens = EXCLUDED.tokens,
       updated_at = now()`,
    [provider, JSON.stringify({ oauth_state: state, placeholder: true })],
  );
  const base = process.env.CALENDAR_OAUTH_BASE_URL ?? 'https://example.com/oauth';
  return {
    provider,
    state,
    oauth_url: `${base}/${provider}?state=${state}&workspace=${membership.workspace_id}`,
  };
}

export async function calendarIntegrationStatus(client, membership) {
  const { rows } = await dbQuery(
    client,
    `SELECT provider, status, connected_at, updated_at FROM calendar_integrations ORDER BY provider`,
  );
  const { rows: logs } = await dbQuery(
    client,
    `SELECT provider, status, created_at FROM calendar_sync_log ORDER BY created_at DESC LIMIT 5`,
  );
  return { integrations: rows, recent_sync: logs };
}

export async function runCalendarSyncPull(client, _payload, _job) {
  const { rows } = await client.query(
    `SELECT provider, status FROM calendar_integrations WHERE status IN ('connected', 'pending')`,
  );
  for (const row of rows) {
    await client.query(
      `INSERT INTO calendar_sync_log (provider, status, detail) VALUES ($1::calendar_provider, 'ok', $2::jsonb)`,
      [row.provider, JSON.stringify({ noop: true, at: new Date().toISOString() })],
    );
  }
  return { pulled: rows.length };
}

registerJob('calendar_sync_pull', runCalendarSyncPull);

export async function scheduleCalendarSync(client) {
  await enqueue(client, 'calendar_sync_pull', {}, {
    dedupeKey: 'calendar_sync_pull',
    runAt: new Date(),
  });
}
