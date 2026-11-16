import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
before(async () => {
  env = await createEnv();
});
after(async () => {
  await env.close();
});

test('calendar feed and ICS token routes', async () => {
  const feed = await env.http(env.fx.owner).get('/calendar');
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(feed.body.items));
  assert.ok(feed.body.today);

  const token = (await env.http(env.fx.owner).get('/calendar/ics-token')).body.token;
  assert.ok(typeof token === 'string' && token.length > 10);
});

test('create event, reminder job, respond, export, delete', async () => {
  const start = new Date(Date.now() + 60 * 60000).toISOString();
  const end = new Date(Date.now() + 120 * 60000).toISOString();

  const created = await env.http(env.fx.owner).post('/calendar/events', {
    title: 'Portfolio review',
    kind: 'review',
    org_id: env.fx.alpha.id,
    starts_at: start,
    ends_at: end,
    reminder_minutes: [30],
    participant_ids: [env.fx.alphaMember1.id],
  });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const eventId = created.body.event.id;

  const from = env.dates.todayIn();
  const to = env.dates.addDays(from, 14);
  const inRange = (items) => items.some((i) => i.id === eventId);
  assert.ok(inRange((await env.http(env.fx.owner).get(`/calendar?from=${from}&to=${to}`)).body.items));
  assert.ok(
    inRange((await env.http(env.fx.alphaManager).get(`/calendar?from=${from}&to=${to}`)).body.items),
    'org manager should see org events in the feed',
  );
  assert.ok(
    inRange((await env.http(env.fx.alphaMember1).get(`/calendar?from=${from}&to=${to}`)).body.items),
    'org members should see org events in the feed',
  );

  await env.sql(`UPDATE users SET phone_e164 = '+911111111111' WHERE id = $1`, [env.fx.owner.user_id]);

  const { rows: jobsBefore } = await env.sql(
    `SELECT count(*)::int AS c FROM jobs WHERE kind = 'event_reminder' AND done_at IS NULL`,
  );
  assert.ok(jobsBefore[0].c >= 1);

  await env.sql(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'event_reminder' AND done_at IS NULL`);

  const { runDueJobs } = await import('../../packages/api/src/jobs/queue.js');
  assert.ok((await runDueJobs(5)) >= 1);

  const { rows: outbox } = await env.sql(
    `SELECT count(*)::int AS c FROM wa_outbox WHERE kind = 'reminder' AND to_phone = '+911111111111'`,
  );
  assert.ok(outbox[0].c >= 1);

  const respond = await env.http(env.fx.alphaMember1).post(`/calendar/events/${eventId}/respond`, { response: 'yes' });
  assert.equal(respond.status, 200);
  assert.equal(respond.body.event?.title, 'Portfolio review');
  assert.equal(respond.body.event?.created_by_name, 'Owner');

  const token = (await env.http(env.fx.owner).get('/calendar/ics-token')).body.token;
  const ics = await fetch(`${env.base}/calendar.ics?token=${encodeURIComponent(token)}`);
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /Portfolio review/);

  assert.equal((await env.http(env.fx.owner).delete(`/calendar/events/${eventId}`)).status, 200);
});

test('overview dashboard returns a greeting and scoped org data', async () => {
  const owner = await env.http(env.fx.owner).get('/dashboards/overview');
  assert.equal(owner.status, 200);
  assert.ok(owner.body.greeting?.name);
  assert.ok(owner.body.as_of);
  assert.ok(Array.isArray(owner.body.attention));
  assert.ok(owner.body.organisations);

  const manager = await env.http(env.fx.alphaManager).get('/dashboards/overview');
  assert.equal(manager.status, 200);
  assert.ok(manager.body.organisations.open + manager.body.organisations.locked <= 1);
  assert.ok(owner.body.organisations.open + owner.body.organisations.locked >= 2);
});

test('overview attention lists KPI owners via workspace_member_name', async () => {
  const asOf = env.dates.todayIn();
  await env.sql(`UPDATE kpis SET owner_id = $1 WHERE id = $2`, [env.fx.owner.id, env.fx.kpiAlpha.id]);
  await env.sql(
    `INSERT INTO scores (workspace_id, org_id, kpi_id, period_date, how_often, value, rag, goal)
     VALUES ($1, $2, $3, $4, 'Every day', 5, 'red', 10)
     ON CONFLICT (kpi_id, period_date, how_often) DO UPDATE SET value = 5, rag = 'red'`,
    [env.fx.wsA.id, env.fx.alpha.id, env.fx.kpiAlpha.id, asOf],
  );

  const manager = await env.http(env.fx.alphaManager).get(`/dashboards/overview?date=${asOf}`);
  assert.equal(manager.status, 200);
  const hit = manager.body.attention.find((a) => a.id === env.fx.kpiAlpha.id);
  assert.ok(hit, 'manager should see red KPI in attention list');
  assert.equal(hit.owner, 'Owner', 'owner name resolved without memberships join');
});

test('target results: each organisation and period shows what was done against its goals', async () => {
  const { fx } = env;
  const { periodWindow } = await env.api('cadence.js');
  const day = env.dates.addDays(env.dates.todayIn(), -9);
  const ws = (await env.sql(`SELECT workspace_id FROM organisations WHERE id = $1`, [fx.alpha.id])).rows[0].workspace_id;
  const kpiId = async (code) => (await env.sql(`SELECT id, org_id FROM kpis WHERE code = $1`, [code])).rows[0];
  const put = async (code, value, state, level = 'manager') => {
    const k = await kpiId(code);
    await env.sql(
      `INSERT INTO submissions (workspace_id, org_id, kpi_id, period_date, level, value, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (kpi_id, period_date, level) DO UPDATE SET value = EXCLUDED.value, state = EXCLUDED.state`,
      [ws, k.org_id, k.id, day, level, value, state],
    );
  };
  // Daily goal is 10 for every fixture KPI.
  await put('alpha.daily', 12, 'validated');   // met
  await put('alpha.other', 5, 'locked');       // missed (< 80%)
  await put('beta.daily', 9, 'submitted');     // waiting for validation
  // A weekly goal of 40 on alpha.daily.
  const alphaDaily = await kpiId('alpha.daily');
  await env.sql(`INSERT INTO kpi_goals (workspace_id, kpi_id, how_often, target) VALUES ($1,$2,'Every week',40)`, [ws, alphaDaily.id]);

  const feed = await env.http(fx.owner).get(`/calendar?from=${day}&to=${day}`);
  assert.equal(feed.status, 200);
  const targets = feed.body.items.filter((i) => i.source === 'target' && i.cadence === 'day');
  const alpha = targets.find((i) => i.org_slug === 'alpha');
  assert.ok(alpha, 'alpha daily result');
  assert.equal(alpha.date, day);
  assert.deepEqual([alpha.summary.met, alpha.summary.missed], [1, 1]);
  assert.equal(alpha.status, 'bad');
  assert.equal(alpha.kpis.find((k) => k.name && k.actual === 12).status, 'met');
  const beta = targets.find((i) => i.org_slug === 'beta');
  assert.equal(beta.summary.pending, 1);
  assert.equal(beta.status, 'none');

  const week = periodWindow('Every week', day);
  const wfeed = await env.http(fx.owner).get(`/calendar?from=${week.start}&to=${week.end}`);
  const weekly = wfeed.body.items.find((i) => i.source === 'target' && i.cadence === 'week' && i.org_slug === 'alpha');
  assert.ok(weekly, 'alpha weekly result');
  assert.equal(weekly.date, week.end);
  assert.equal(weekly.kpis[0].actual, 12);
  assert.equal(weekly.kpis[0].goal, 40);
  assert.equal(weekly.kpis[0].status, 'missed');

  // A manager sees only their own organisation's results.
  const mine = await env.http(fx.alphaManager).get(`/calendar?from=${day}&to=${day}`);
  const orgsSeen = new Set(mine.body.items.filter((i) => i.source === 'target').map((i) => i.org_slug));
  assert.deepEqual([...orgsSeen], ['alpha']);
});
