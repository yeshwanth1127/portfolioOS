import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let today;
let alphaUnitId;

before(async () => {
  env = await createEnv();
  today = env.dates.todayIn();
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  alphaUnitId = rows[0].id;
});
after(async () => {
  delete process.env.REPORTS_RUNNER_URL;
  await env.close();
});

async function waitReady(who, id) {
  for (let i = 0; i < 80; i += 1) {
    const r = await env.http(who).get(`/reports/generated/${id}`);
    if (r.body?.report && ['ready', 'failed'].includes(r.body.report.status)) return r.body.report;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('report did not finish');
}

async function makeReport(who, body) {
  const created = await env.http(who).post('/reports/generated', { from: today, to: today, ...body });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return waitReady(who, created.body.report.id);
}

test('options follow the role: members get personal reports, only the owner gets sign-ins', async () => {
  const member = (await env.http(env.fx.alphaMember1).get('/reports/options')).body;
  assert.deepEqual(member.types.map((t) => t.id).sort(), ['my_work', 'task_delivery']);
  assert.deepEqual(member.scopes.map((s) => s.kind), ['me']);
  assert.equal(member.people.length, 0);

  const lead = (await env.http(env.fx.alphaLead).get('/reports/options')).body;
  assert.ok(lead.scopes.some((s) => s.kind === 'team'));
  assert.deepEqual(lead.people.map((p) => p.label), ['Alpha Member One']);

  const owner = (await env.http(env.fx.owner).get('/reports/options')).body;
  assert.ok(owner.types.some((t) => t.id === 'logins'));
  assert.ok(owner.scopes.some((s) => s.kind === 'workspace'));
  const mgr = (await env.http(env.fx.alphaManager).get('/reports/options')).body;
  assert.ok(!mgr.types.some((t) => t.id === 'logins'));
});

test('scope and type are enforced', async () => {
  const notMine = await env.http(env.fx.alphaMember1).post('/reports/generated', {
    report_type: 'my_work',
    scope_kind: 'person',
    scope_ref: env.fx.alphaMember2.id,
  });
  assert.equal(notMine.status, 403);
  const kpi = await env.http(env.fx.alphaMember1).post('/reports/generated', { report_type: 'kpi_performance' });
  assert.equal(kpi.status, 403);
  const otherOrg = await env.http(env.fx.alphaManager).post('/reports/generated', {
    report_type: 'task_delivery',
    scope_kind: 'person',
    scope_ref: env.fx.betaMember.id,
  });
  assert.equal(otherOrg.status, 403);
  const leadOutside = await env.http(env.fx.alphaLead).post('/reports/generated', {
    report_type: 'task_delivery',
    scope_kind: 'person',
    scope_ref: env.fx.alphaMember2.id,
  });
  assert.equal(leadOutside.status, 403, 'member2 is not in the team lead\'s team');
  const future = await env.http(env.fx.owner).post('/reports/generated', {
    report_type: 'task_delivery',
    from: env.dates.addDays(today, 3),
    to: env.dates.addDays(today, 4),
  });
  assert.equal(future.status, 400);
});

test('task delivery and work report count real completed work', async () => {
  const project = await env.http(env.fx.alphaManager).post('/projects', { name: 'Report project', unit_id: alphaUnitId, status: 'active' });
  const pid = project.body.project.id;
  const t1 = await env.http(env.fx.alphaManager).post(`/projects/${pid}/tasks`, {
    title: 'Ship the brochure',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(today, 2),
  });
  await env.http(env.fx.alphaManager).post(`/projects/${pid}/tasks`, {
    title: 'Late thing',
    assignee_id: env.fx.alphaMember1.id,
    due_on: env.dates.addDays(today, -3),
  });
  const done = await env.http(env.fx.alphaMember1).patch(`/tasks/${t1.body.task.id}`, { status: 'done' });
  assert.equal(done.status, 200);

  const mgr = await makeReport(env.fx.alphaManager, { report_type: 'task_delivery', scope_kind: 'org' });
  assert.equal(mgr.status, 'ready', mgr.error);
  assert.equal(mgr.narrative_source, 'template');
  const totals = mgr.datasets.tasks_by_person.totals;
  assert.equal(totals.completed, 1);
  assert.equal(totals.on_time, 1);
  assert.equal(totals.overdue, 1);
  const row = mgr.datasets.tasks_by_person.rows.find((r) => r.person === 'Alpha Member One');
  assert.equal(row.completed, 1);
  assert.match(mgr.spec.summary, /1 task completed/);
  assert.ok(mgr.spec.sections.length >= 2);

  const mine = await makeReport(env.fx.alphaMember1, { report_type: 'my_work' });
  assert.equal(mine.status, 'ready', mine.error);
  assert.equal(mine.scope_kind, 'me');
  assert.equal(mine.datasets.tasks_completed.rows.length, 1);
  assert.equal(mine.datasets.tasks_completed.rows[0].task, 'Ship the brochure');
  assert.ok(mine.datasets.work_log.rows.some((r) => r.kind === 'Task completed'));
});

test('attendance: clock in/out, team lead sees the team, members only themselves', async () => {
  const m1 = env.http(env.fx.alphaMember1);
  assert.equal((await m1.post('/attendance/clock', { kind: 'out' })).status, 409);
  const inn = await m1.post('/attendance/clock', {});
  assert.equal(inn.status, 200);
  assert.equal(inn.body.state, 'in');
  assert.equal((await m1.post('/attendance/clock', { kind: 'in' })).status, 409);
  const out = await m1.post('/attendance/clock', { kind: 'out' });
  assert.equal(out.body.state, 'out');

  const lead = await makeReport(env.fx.alphaLead, { report_type: 'attendance', scope_kind: 'team' });
  assert.equal(lead.status, 'ready', lead.error);
  assert.equal(lead.datasets.attendance_by_person.totals.person_days, 1);
  assert.equal(lead.datasets.attendance_log.rows[0].person, 'Alpha Member One');

  // Another member cannot read member1's clock events.
  const seen = await env.as(env.fx.alphaMember2, (c) => c.query(`SELECT count(*)::int AS n FROM attendance_events`));
  assert.equal(seen.rows[0].n, 0);
  const seenByLead = await env.as(env.fx.alphaLead, (c) => c.query(`SELECT count(*)::int AS n FROM attendance_events`));
  assert.equal(seenByLead.rows[0].n, 2);
});

test('sign-ins report reads every person’s timesheet clock in and out', async () => {
  const res = await fetch(`${env.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alpha.member.two@test.local', password: 'password123' }),
  });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  await fetch(`${env.base}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const { rows } = await env.sql(`SELECT kind FROM auth_events WHERE membership_id = $1 ORDER BY at`, [env.fx.alphaMember2.id]);
  assert.deepEqual(rows.map((r) => r.kind), ['login', 'logout']);

  // A web sign-in is not a timesheet punch. Member two has logged in and out, and has not clocked.
  const before = await makeReport(env.fx.owner, { report_type: 'logins' });
  assert.equal(before.status, 'ready', before.error);
  const beforeTwo = before.datasets.logins_by_person.rows.find((r) => r.person === 'Alpha Member Two');
  assert.equal(beforeTwo.logins, 0);
  assert.equal(beforeTwo.logouts_recorded, 0);
  // Member one clocked in and out in the attendance test; that punch is in this report too.
  const beforeOne = before.datasets.logins_by_person.rows.find((r) => r.person === 'Alpha Member One');
  assert.equal(beforeOne.logins, 1);
  assert.equal(beforeOne.logouts_recorded, 1);
  assert.equal(before.datasets.logins_by_person.rows.length, before.datasets.logins_by_person.totals.people);
  const ownerRow = before.datasets.logins_by_person.rows.find((r) => r.person === 'Owner');
  assert.equal(ownerRow.logins, 0);

  const m2 = env.http(env.fx.alphaMember2);
  assert.equal((await m2.post('/attendance/clock', { kind: 'in' })).status, 200);
  assert.equal((await m2.post('/attendance/clock', { kind: 'out' })).status, 200);

  const owner = await makeReport(env.fx.owner, { report_type: 'logins' });
  assert.equal(owner.status, 'ready', owner.error);
  const row = owner.datasets.logins_by_person.rows.find((r) => r.person === 'Alpha Member Two');
  assert.equal(row.logins, 1);
  assert.equal(row.logouts_recorded, 1);
  const day = owner.datasets.logins_log.rows.find((r) => r.person === 'Alpha Member Two');
  assert.ok(day.first_login);
  assert.ok(day.last_logout);
  assert.equal((await env.http(env.fx.alphaManager).post('/reports/generated', { report_type: 'logins' })).status, 403);
});

test('submit to manager, privacy, exports', async () => {
  const mine = await makeReport(env.fx.alphaMember1, { report_type: 'my_work' });
  assert.equal(mine.can_submit, true);
  assert.equal((await env.http(env.fx.alphaMember2).get(`/reports/generated/${mine.id}`)).status, 404);
  assert.equal((await env.http(env.fx.alphaLead).get(`/reports/generated/${mine.id}`)).status, 404);

  const sub = await env.http(env.fx.alphaMember1).post(`/reports/generated/${mine.id}/submit`);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.submitted_to, env.fx.alphaLead.id);
  const leadList = await env.http(env.fx.alphaLead).get('/reports/generated');
  assert.ok(leadList.body.shared.some((r) => r.id === mine.id));
  assert.equal((await env.http(env.fx.alphaLead).get(`/reports/generated/${mine.id}`)).status, 200);
  assert.equal((await env.http(env.fx.alphaLead).delete(`/reports/generated/${mine.id}`)).status, 403);

  const token = env.auth.signToken(env.fx.alphaMember1);
  const csv = await fetch(`${env.base}/reports/generated/${mine.id}/export.csv`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Work report/);
  const xlsx = await fetch(`${env.base}/reports/generated/${mine.id}/export.xlsx`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(xlsx.status, 200);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('KPI report reads scores; reporting report counts submissions', async () => {
  await env.sql(
    `INSERT INTO scores (workspace_id, org_id, kpi_id, period_date, how_often, value, rag)
     VALUES ($5,$1,$2,$3,'Every day',12,'green'), ($5,$1,$4,$3,'Every day',3,'red')`,
    [env.fx.alpha.id, env.fx.kpiAlpha.id, today, env.fx.kpiAlphaOther.id, env.fx.wsA.id],
  );
  await env.sql(
    `INSERT INTO submissions (workspace_id, org_id, kpi_id, period_date, level, value, state, submitted_by, submitted_at)
     VALUES ($5,$1,$2,$3,'member',12,'validated',$4, now())`,
    [env.fx.alpha.id, env.fx.kpiAlpha.id, today, env.fx.alphaMember1.id, env.fx.wsA.id],
  );
  const kpi = await makeReport(env.fx.alphaManager, { report_type: 'kpi_performance' });
  assert.equal(kpi.status, 'ready', kpi.error);
  const t = kpi.datasets.kpi_by_kpi.totals;
  assert.equal(t.kpis, 2);
  assert.equal(t.good, 1);
  assert.equal(t.bad, 1);
  assert.equal(t.attainment, 0.5);
  const rep = await makeReport(env.fx.alphaManager, { report_type: 'reporting' });
  assert.equal(rep.datasets.reporting_by_person.totals.expected, 2);
  assert.equal(rep.datasets.reporting_by_person.totals.received, 1);

  const owner = await makeReport(env.fx.owner, { report_type: 'people' });
  assert.equal(owner.status, 'ready', owner.error);
  assert.ok(owner.datasets.scorecard.rows.length >= 8);
});

test('Qlix agent drafts the narrative from report_data; unbacked numbers are dropped', async () => {
  let toolResult = null;
  let catalog = null;
  const stub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    // Same steps as services/agent-runner: mint a run token, then the agent calls tools with it.
    const mint = await fetch(`${env.base}/agent/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
      body: JSON.stringify({ membership_id: body.membership_id, agent_id: body.agent_id, message: body.message, profile: body.profile, report_id: body.report_id, channel: body.channel }),
    });
    const { run_token: runToken } = await mint.json();
    catalog = await (await fetch(`${env.base}/agent/tools/catalog`, { headers: { authorization: `Bearer ${runToken}` } })).json();
    const call = await fetch(`${env.base}/agent/tools/portfolio_os`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'report_data' }),
    });
    toolResult = await call.json();
    const completed = toolResult.datasets.tasks_by_person.totals.completed;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        reply: `SUMMARY: ${completed} task was completed this period. Revenue grew 47%.\nHIGHLIGHTS:\n- Brochure shipped on time\nWATCH:\n- 999 tasks are blocked`,
        tools: [{ action: 'report_data', result: {} }],
      }),
    );
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.REPORTS_RUNNER_URL = `http://127.0.0.1:${stub.address().port}`;
  try {
    const report = await makeReport(env.fx.alphaManager, { report_type: 'task_delivery', scope_kind: 'org' });
    assert.equal(report.status, 'ready', report.error);
    assert.deepEqual(catalog.tools.map((t) => t.action), ['report_data']);
    assert.equal(toolResult.report.type, 'task_delivery');
    assert.equal(report.narrative_source, 'agent');
    assert.equal(report.spec.summary, '1 task was completed this period.');
    assert.deepEqual(report.spec.highlights, ['Brochure shipped on time']);
    assert.deepEqual(report.spec.watch, []);
    assert.match(report.spec.narrative_note, /2 line/);
  } finally {
    delete process.env.REPORTS_RUNNER_URL;
    await new Promise((r) => stub.close(r));
  }

  // report_data is refused on a normal (non-report) token.
  const plain = await env.http(env.fx.alphaManager).post('/agent/tools/portfolio_os', { action: 'report_data' });
  assert.equal(plain.body.error.code, 'forbidden');
});

test('generate_report and clock tools work from the agent', async () => {
  const gen = await env.http(env.fx.alphaMember2).post('/agent/tools/portfolio_os', {
    action: 'generate_report',
    report_type: 'my_work',
    from: today,
    to: today,
  });
  assert.equal(gen.body.ok, true, JSON.stringify(gen.body));
  const { rows } = await env.sql(`SELECT kind FROM jobs WHERE kind = 'report_generate'`);
  assert.equal(rows.length, 1);
  const clockIn = await env.http(env.fx.alphaMember2).post('/agent/tools/portfolio_os', { action: 'clock_in' });
  assert.equal(clockIn.body.state, 'in');
});
