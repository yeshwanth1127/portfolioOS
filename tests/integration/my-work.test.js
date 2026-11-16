import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let alphaUnitId;

before(async () => {
  env = await createEnv();
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  alphaUnitId = rows[0]?.id;
});
after(async () => {
  await env.close();
});

test('calendar feed includes task due dates and milestones', async () => {
  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'Feed test',
    unit_id: alphaUnitId,
    status: 'active',
  });
  assert.equal(created.status, 200);
  const projectId = created.body.project.id;
  const due = env.dates.addDays(env.dates.todayIn(), 5);

  const task = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Calendar task',
    assignee_id: env.fx.alphaMember1.id,
    due_on: due,
  });
  assert.equal(task.status, 200);

  await env.sql(
    `INSERT INTO milestones (workspace_id, project_id, name, due_on, owner_id, status)
     VALUES ($1, $2, 'Ship beta', $3, $4, 'open')`,
    [env.fx.wsA.id, projectId, due, env.fx.alphaManager.id],
  );

  const from = env.dates.todayIn();
  const to = env.dates.addDays(from, 14);
  const feed = await env.http(env.fx.alphaMember1).get(`/calendar?from=${from}&to=${to}`);
  assert.equal(feed.status, 200);
  const ids = new Set(feed.body.items.map((i) => i.id));
  assert.ok(ids.has(`task:${task.body.task.id}`), 'task due in feed');
  assert.ok([...ids].some((id) => id.startsWith('milestone:')), 'milestone due in feed');
});

test('task assignment enqueues in-app notification job', async () => {
  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'Notify test',
    unit_id: alphaUnitId,
    status: 'active',
  });
  const projectId = created.body.project.id;

  const task = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Ping me',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(env.dates.todayIn(), 3),
  });
  assert.equal(task.status, 200);
  const taskId = task.body.task.id;

  await env.sql(
    `UPDATE jobs SET run_at = now() - interval '1 second'
     WHERE kind = 'task_notify' AND dedupe_key = $1`,
    [`task:${taskId}:assigned:${env.fx.alphaMember1.id}`],
  );

  const { runDueJobs } = await import('../../packages/api/src/jobs/queue.js');
  assert.ok((await runDueJobs(10)) >= 1);

  const { rows } = await env.sql(
    `SELECT kind, body FROM notifications
     WHERE membership_id = $1 AND task_id = $2`,
    [env.fx.alphaMember1.id, taskId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'task_assigned');
  assert.match(rows[0].body, /Ping me/);
});

test('overview delivery stats and my-work payload', async () => {
  const overview = await env.http(env.fx.alphaManager).get('/dashboards/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.delivery);
  assert.ok(overview.body.delivery.open_tasks >= 1);

  const work = await env.http(env.fx.alphaMember1).get('/my-work');
  assert.equal(work.status, 200);
  assert.ok(Array.isArray(work.body.tasks));
  assert.ok(Array.isArray(work.body.milestones));
  assert.ok(Array.isArray(work.body.approvals));
});
