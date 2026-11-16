import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let alphaUnitId;
let attachDir;

before(async () => {
  attachDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pt-attach-'));
  process.env.ATTACHMENTS_DIR = attachDir;
  env = await createEnv();
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  alphaUnitId = rows[0]?.id;
  assert.ok(alphaUnitId, 'alpha organisation unit');
});

after(async () => {
  if (env) await env.close();
  if (attachDir) await fs.rm(attachDir, { recursive: true, force: true });
});

async function projectWithTasks(manager) {
  const created = await env.http(manager).post('/projects', {
    name: 'Expansion fixture',
    unit_id: alphaUnitId,
    status: 'active',
  });
  assert.equal(created.status, 200);
  const projectId = created.body.project.id;
  const ids = [];
  for (const title of ['Task A', 'Task B', 'Task C']) {
    const t = await env.http(manager).post(`/projects/${projectId}/tasks`, { title });
    assert.equal(t.status, 200);
    ids.push(t.body.task.id);
  }
  return { projectId, taskIds: ids };
}

test('task dependencies chain and cycle rejection', async () => {
  const { projectId, taskIds: [a, b, c] } = await projectWithTasks(env.fx.alphaManager);
  const ab = await env.http(env.fx.alphaManager).post(`/tasks/${b}/dependencies`, {
    predecessor_id: a,
    successor_id: b,
  });
  assert.equal(ab.status, 200);
  const bc = await env.http(env.fx.alphaManager).post(`/tasks/${c}/dependencies`, {
    predecessor_id: b,
    successor_id: c,
  });
  assert.equal(bc.status, 200);

  const graph = await env.http(env.fx.alphaManager).get(`/projects/${projectId}/dependency-graph`);
  assert.equal(graph.status, 200);
  assert.equal(graph.body.edges.length, 2);

  const cycle = await env.http(env.fx.alphaManager).post(`/tasks/${a}/dependencies`, {
    predecessor_id: c,
    successor_id: a,
  });
  assert.equal(cycle.status, 409);
  assert.match(cycle.body.error.message, /cycle/i);
});

test('project template list and instantiate', async () => {
  const templates = await env.http(env.fx.alphaManager).get('/project-templates');
  assert.equal(templates.status, 200);
  assert.ok(templates.body.templates.some((t) => t.name === 'Standard delivery'));
  const templateId = templates.body.templates[0].id;

  const created = await env.http(env.fx.alphaManager).post(`/projects/from-template/${templateId}`, {
    unit_id: alphaUnitId,
    name: 'From template',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.project.name, 'From template');
  assert.ok(created.body.tasks.length >= 3);
});

test('attachment roundtrip', async () => {
  const { projectId } = await projectWithTasks(env.fx.alphaManager);
  const key = `proj-${projectId.slice(0, 8)}.txt`;
  const posted = await env.http(env.fx.alphaManager).post('/attachments', {
    entity_type: 'project',
    entity_id: projectId,
    file_name: 'notes.txt',
    mime_type: 'text/plain',
    storage_key: key,
    content: 'hello phase 9',
  });
  assert.equal(posted.status, 200);
  const id = posted.body.attachment.id;
  const got = await env.http(env.fx.alphaManager).get(`/attachments/${id}`);
  assert.equal(got.status, 200);
  const bytes = Buffer.from(got.body.content_base64, 'base64').toString('utf8');
  assert.equal(bytes, 'hello phase 9');
});

test('saved view and workload', async () => {
  const { taskIds: [a] } = await projectWithTasks(env.fx.alphaManager);
  await env.http(env.fx.alphaManager).patch(`/tasks/${a}`, {
    assignee_id: env.fx.alphaMember1.id,
    estimate_hours: 4,
  });

  const view = await env.http(env.fx.alphaMember1).post('/saved-views', {
    name: 'My open',
    route: '/projects',
    filters: { status: 'active' },
  });
  assert.equal(view.status, 200);
  const listed = await env.http(env.fx.alphaMember1).get('/saved-views');
  assert.ok(listed.body.views.some((v) => v.id === view.body.view.id));

  const load = await env.http(env.fx.alphaManager).get(`/workload?unit_id=${alphaUnitId}`);
  assert.equal(load.status, 200);
  const row = load.body.assignees.find((r) => r.assignee_id === env.fx.alphaMember1.id);
  assert.ok(row);
  assert.ok(row.open_tasks >= 1);
  assert.ok(Number(row.estimate_hours) >= 4);
});

test('calendar connect stub and sync job log', async () => {
  const connect = await env.http(env.fx.owner).post('/integrations/calendar/connect', { provider: 'google' });
  assert.equal(connect.status, 200);
  assert.ok(connect.body.oauth_url);

  await env.as(env.fx.owner, (c) => c.query(`SELECT auth.enqueue_job('calendar_sync_pull', '{}'::jsonb, now(), 'calendar_sync_pull')`));
  const { runDueJobs } = await import('../../packages/api/src/jobs/queue.js');
  assert.ok((await runDueJobs(5)) >= 1);

  const status = await env.http(env.fx.owner).get('/integrations/calendar/status');
  assert.ok(status.body.recent_sync?.length >= 1);
});

test('billing checkout mock and webhook', async () => {
  const checkout = await env.http(env.fx.owner).post('/billing/checkout-session');
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.mode, 'mock');
  assert.ok(checkout.body.checkout_url);

  const hook = await fetch(`${env.base}/billing/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-billing-secret': 'dev-billing-webhook-secret',
    },
    body: JSON.stringify({
      workspace_id: env.fx.owner.workspace_id,
      plan_code: 'pilot',
      subscription_status: 'active',
      stripe_customer_id: 'cus_test_123',
    }),
  });
  const body = await hook.json();
  assert.equal(hook.status, 200);
  assert.equal(body.customer.subscription_status, 'active');
});
