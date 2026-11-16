import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let alphaUnitId;

before(async () => {
  env = await createEnv();
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  alphaUnitId = rows[0]?.id;
  assert.ok(alphaUnitId, 'alpha organisation unit');
});
after(async () => {
  await env.close();
});

test('create project and task with RLS', async () => {
  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'Launch pad',
    unit_id: alphaUnitId,
    status: 'active',
  });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const projectId = created.body.project.id;

  const listed = await env.http(env.fx.alphaManager).get('/projects');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.projects.some((p) => p.id === projectId));

  const task = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Wire checklist',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(env.dates.todayIn(), 7),
  });
  assert.equal(task.status, 200);
  const taskId = task.body.task.id;

  const memberView = await env.http(env.fx.alphaMember1).get('/my-work');
  assert.equal(memberView.status, 200);
  assert.ok(memberView.body.tasks.some((t) => t.id === taskId));

  const memberCannotCreate = await env.http(env.fx.alphaMember1).post('/projects', {
    name: 'Nope',
    unit_id: alphaUnitId,
  });
  assert.equal(memberCannotCreate.status, 403);

  const otherOrg = await env.http(env.fx.betaManager).get(`/projects/${projectId}`);
  assert.equal(otherOrg.status, 404, 'RLS hides cross-org project');

  const done = await env.http(env.fx.alphaMember1).patch(`/tasks/${taskId}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.status, 'done');
});
