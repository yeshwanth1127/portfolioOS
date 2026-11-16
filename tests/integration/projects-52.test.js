import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let alphaUnitId;

before(async () => {
  env = await createEnv();
  await env.sql(`UPDATE users SET phone_e164 = '+911111111111' WHERE id = (
    SELECT user_id FROM memberships WHERE id = $1
  )`, [env.fx.alphaMember1.id]);
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  alphaUnitId = rows[0]?.id;
});
after(async () => {
  await env.close();
});

test('milestones CRUD, comments, activity log, agent complete_task', async () => {
  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'Phase 5.2',
    unit_id: alphaUnitId,
    status: 'active',
  });
  assert.equal(created.status, 200);
  const projectId = created.body.project.id;

  const milestone = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/milestones`, {
    name: 'Beta ship',
    due_on: env.dates.addDays(env.dates.todayIn(), 10),
    owner_id: env.fx.alphaManager.id,
  });
  assert.equal(milestone.status, 200);

  const task = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Ship widget',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(env.dates.todayIn(), 2),
  });
  assert.equal(task.status, 200);
  const taskId = task.body.task.id;

  const comment = await env.http(env.fx.alphaMember1).post('/comments', {
    task_id: taskId,
    body: 'Almost there',
  });
  assert.equal(comment.status, 200);

  const listed = await env.http(env.fx.alphaManager).get(`/comments?task_id=${taskId}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.comments.length, 1);

  const update = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/updates`, {
    body: 'Green for launch week',
  });
  assert.equal(update.status, 200);

  const agentDone = await env.http(env.fx.alphaMember1).post('/agent/tools/portfolio_os', {
    action: 'complete_task',
    task_id: taskId,
  });
  assert.equal(agentDone.status, 200);
  assert.equal(agentDone.body.task.status, 'done');

  const activity = await env.http(env.fx.alphaManager).get(`/projects/${projectId}/activity`);
  assert.equal(activity.status, 200);
  const kinds = new Set(activity.body.activity.map((a) => a.kind));
  assert.ok(kinds.has('project.created'));
  assert.ok(kinds.has('task.created'));
  assert.ok(kinds.has('comment.added'));
  assert.ok(kinds.has('task.completed'));
  assert.ok(kinds.has('milestone.created'));
  assert.ok(kinds.has('project_update.posted'));

  const detail = await env.http(env.fx.alphaManager).get(`/projects/${projectId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.project.health);
  assert.equal(detail.body.project.health.calculated, 'on_track');
});

test('task_notify queues WhatsApp outbox when assignee has phone', async () => {
  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'WA notify',
    unit_id: alphaUnitId,
    status: 'active',
  });
  const projectId = created.body.project.id;
  const task = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Call site',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(env.dates.todayIn(), 1),
  });
  const taskId = task.body.task.id;

  await env.sql(
    `UPDATE jobs SET run_at = now() - interval '1 second'
     WHERE kind = 'task_notify' AND dedupe_key = $1`,
    [`task:${taskId}:assigned:${env.fx.alphaMember1.id}`],
  );
  const { runDueJobs } = await import('../../packages/api/src/jobs/queue.js');
  await runDueJobs(10);

  const { rows: outbox } = await env.sql(
    `SELECT body FROM wa_outbox WHERE kind = 'task_notify' AND to_phone = '+911111111111'`,
  );
  assert.ok(outbox.some((r) => /Call site/.test(r.body)));

  const { rows: waChan } = await env.sql(
    `SELECT channel FROM notifications WHERE membership_id = $1 AND task_id = $2 AND channel = 'whatsapp'`,
    [env.fx.alphaMember1.id, taskId],
  );
  assert.equal(waChan.length, 1);
});
