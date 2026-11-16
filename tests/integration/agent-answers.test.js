import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

/*
 * Agent tools give the model answers it can quote, consistent with reports:
 *   list_orgs states its counts (models miscount long lists);
 *   list_off_track without a date uses the latest scored day, like reports' "off track now".
 */
let env;
before(async () => { env = await createEnv(); });
after(async () => { await env.close(); });

const tool = (membership, body) => env.http(membership).post('/agent/tools/portfolio_os', body);

test('list_orgs states the total and counts by kind', async () => {
  const out = await tool(env.fx.owner, { action: 'list_orgs' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.total, out.body.orgs.length);
  const { organisations, departments, test: testOrgs } = out.body.counts;
  assert.equal(organisations + departments + testOrgs, out.body.total);
  assert.ok(out.body.orgs.every((o) => o.slug && o.kind), 'compact rows');
  assert.ok(!('positioning' in out.body.orgs[0]), 'long profile text left out');
});

test('list_off_track without a date reports the latest scored day and says so', async () => {
  const day = env.dates.addDays(env.dates.todayIn('Asia/Kolkata'), -3);
  await env.sql(
    `INSERT INTO scores (workspace_id, org_id, kpi_id, period_date, how_often, value, rag)
     VALUES ($1, $2, $3, $4, 'Every day', 3, 'red')`,
    [env.fx.wsA.id, env.fx.alpha.id, env.fx.kpiAlphaOther.id, day],
  );
  const out = await tool(env.fx.owner, { action: 'list_off_track' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.date, day);
  assert.equal(out.body.counts.bad, 1);
  assert.match(out.body.note, /latest scored day/);

  // An explicit date is still honoured exactly.
  const today = env.dates.todayIn('Asia/Kolkata');
  const explicit = await tool(env.fx.owner, { action: 'list_off_track', date: today });
  assert.equal(explicit.body.date, today);
  assert.equal(explicit.body.off_track.length, 0);
});
