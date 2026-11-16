import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';
import { deliveryScopeSql, parseDashboardQuery } from '../../packages/api/src/modules/dashboards/scope.js';

let env;
let unitId;
let projectId;
let asOf;

before(async () => {
  env = await createEnv();
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  unitId = rows[0].id;
  asOf = env.dates.todayIn();

  const created = await env.http(env.fx.alphaManager).post('/projects', {
    name: 'Dash reconcile',
    unit_id: unitId,
    status: 'active',
  });
  projectId = created.body.project.id;

  const due = env.dates.addDays(asOf, 3);
  await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Open task',
    assignee_id: env.fx.alphaMember1.id,
    due_on: due,
  });
  const doneOnTime = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Done on time',
    assignee_id: env.fx.alphaMember1.id,
    due_on: asOf,
  });
  await env.http(env.fx.alphaMember1).patch(`/tasks/${doneOnTime.body.task.id}`, { status: 'done' });
  await env.sql(
    `UPDATE tasks SET completed_at = ($1::date + time '10:00') AT TIME ZONE 'Asia/Kolkata' WHERE id = $2`,
    [asOf, doneOnTime.body.task.id],
  );

  const lateTask = await env.http(env.fx.alphaManager).post(`/projects/${projectId}/tasks`, {
    title: 'Done late',
    assignee_id: env.fx.alphaMember1.id,
    due_on: asOf,
  });
  await env.http(env.fx.alphaMember1).patch(`/tasks/${lateTask.body.task.id}`, { status: 'done' });
  await env.sql(
    `UPDATE tasks SET completed_at = (($1::date + 1) + time '10:00') AT TIME ZONE 'Asia/Kolkata' WHERE id = $2`,
    [asOf, lateTask.body.task.id],
  );

  await env.as(env.fx.alphaMember1, async (client) => {
    const { recordNumber } = await import('../../packages/api/src/domain/submissions.js');
    await recordNumber(client, env.fx.alphaMember1, {
      org_slug: 'alpha',
      kpi_code: env.fx.kpiAlpha.code,
      period_date: asOf,
      value: 5,
    });
  });
});

after(async () => {
  await env.close();
});

async function independentTaskCompletion(client, scope) {
  const { where, params } = deliveryScopeSql(scope, 1);
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE t.status = 'done')::int AS done,
       count(*) FILTER (WHERE t.status NOT IN ('done','cancelled'))::int AS open,
       count(*) FILTER (WHERE t.status <> 'cancelled')::int AS total,
       count(*) FILTER (WHERE t.status <> 'cancelled' AND t.assignee_id IS NOT NULL)::int AS assigned
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE TRUE ${where}`,
    params,
  );
  return rows[0];
}

async function independentReporting(client, scope) {
  const orgFilter = scope.orgId ? ' AND k.org_id = $1' : '';
  const kpiParams = scope.orgId ? [scope.orgId] : [];
  const { rows: kpis } = await client.query(`SELECT k.id FROM kpis k WHERE TRUE${orgFilter}`, kpiParams);
  let dayCount = 0;
  for (let d = scope.from; d <= scope.to; d = env.dates.addDays(d, 1)) dayCount += 1;
  const expected = kpis.length * dayCount;
  const subParams = [scope.from, scope.to, ...(scope.orgId ? [scope.orgId] : [])];
  const { rows: subs } = await client.query(
    `SELECT count(*)::int AS received
     FROM submissions s
     WHERE s.period_date BETWEEN $1::date AND $2::date
       AND s.state IN ('submitted','validated','locked')
       ${scope.orgId ? 'AND s.org_id = $3' : ''}`,
    subParams,
  );
  return { expected, received: subs[0].received };
}

test('dashboard measures reconcile with independent SQL', async () => {
  const dash = await env.http(env.fx.owner).get(`/dashboards/owner?date=${asOf}&from=${asOf}&to=${asOf}`);
  assert.equal(dash.status, 200);
  const m = dash.body.measures;

  const scope = parseDashboardQuery(env.fx.owner, { date: asOf, from: asOf, to: asOf }, { kind: 'owner' });
  const direct = await env.as(env.fx.owner, (c) => independentTaskCompletion(c, scope));
  assert.equal(m.task_completion.value.done, direct.done);
  assert.equal(m.task_completion.value.open, direct.open);

  const rep = await env.as(env.fx.owner, (c) => independentReporting(c, scope));
  assert.equal(m.reporting_completeness.value.expected, rep.expected);
  assert.equal(m.reporting_completeness.value.received, rep.received);

  assert.equal(m.on_time_delivery.value.on_time, 1);
  assert.equal(m.on_time_delivery.value.late_done, 1);
});

test('overview includes structured measures without breaking cards', async () => {
  const ov = await env.http(env.fx.owner).get('/dashboards/overview');
  assert.equal(ov.status, 200);
  assert.ok(ov.body.measures?.task_completion);
  assert.ok(ov.body.freshness?.as_of);
  assert.ok(ov.body.delivery?.open_tasks >= 1);
});

test('reports CSV export matches summary measures', async () => {
  const summary = await env.http(env.fx.owner).get('/reports/summary');
  assert.equal(summary.status, 200);
  const token = env.auth.signToken(env.fx.owner);
  const res = await fetch(`${env.base}/reports/export.csv`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /task_completion/);
  assert.ok(text.includes(String(summary.body.measures.task_completion.value.done)));
});

test('workspace_digest job matches owner dashboard counts', async () => {
  const ownerDash = await env.http(env.fx.owner).get('/dashboards/owner');
  assert.equal(ownerDash.status, 200);

  const period = env.dates.todayIn();
  await env.as(env.fx.owner, async (client) => {
    const { enqueue } = await import('../../packages/api/src/jobs/queue.js');
    await import('../../packages/api/src/jobs/digest.js');
    await enqueue(client, 'workspace_digest', { period, timezone: 'Asia/Kolkata' }, {
      runAt: new Date(),
      dedupeKey: `digest:${period}:test`,
    });
  });

  await env.sql(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'workspace_digest'`);
  const { runDueJobs } = await import('../../packages/api/src/jobs/queue.js');
  assert.ok((await runDueJobs(5)) >= 1);

  const { rows } = await env.sql(
    `SELECT body FROM notifications WHERE kind = 'digest' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.ok(rows[0]?.body);
  assert.match(rows[0].body, /Tasks:/);
  const tc = ownerDash.body.measures.task_completion.value;
  assert.match(rows[0].body, new RegExp(`${tc.done} done`));
});
