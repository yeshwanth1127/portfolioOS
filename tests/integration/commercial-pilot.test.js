import assert from 'node:assert/strict';
import fs from 'fs';
import { after, before, test } from 'node:test';
import { _testExhaustKey } from '../../packages/api/src/middleware/rate-limit.js';
import { createEnv } from '../helpers/env.js';

let env;
before(async () => {
  env = await createEnv();
});
after(async () => {
  await env.close();
});

const SAMPLE_CSV = `# people
email,full_name,role,org_slug
imported@test.local,Imported User,member,alpha

# units
name,type,parent_slug
Import Branch,branch,alpha

# kpis
code,name,org_slug
import.test,Import KPI,alpha
`;

test('entitlements deny projects when plan lacks feature', async () => {
  await env.as(env.fx.owner, (c) =>
    c.query(`SELECT auth.set_workspace_entitlement($1, 'limited', NULL, '{}'::jsonb)`, [env.fx.wsA.id]),
  );
  const membership = await env.auth.loadMembership(env.fx.owner.id);
  const res = await env.http(membership).post('/projects', {
    name: 'Blocked by plan',
    unit_id: env.fx.alphaBranch.id,
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error?.message ?? '', /plan does not include projects/);

  await env.as(env.fx.owner, (c) =>
    c.query(`SELECT auth.set_workspace_entitlement($1, 'pilot', NULL, '{}'::jsonb)`, [env.fx.wsA.id]),
  );
});

test('CSV dry-run vs apply', async () => {
  const dry = await env.http(env.fx.owner).post('/onboarding/import-csv', { csv: SAMPLE_CSV });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.valid, true);
  assert.ok(dry.body.dry_run_token);

  const bad = await env.http(env.fx.owner).post('/onboarding/import-csv', {
    csv: `# people\nemail,full_name\n,broken`,
  });
  assert.equal(bad.body.valid, false);
  assert.ok(bad.body.errors?.length);

  const applied = await env.http(env.fx.owner).post('/onboarding/apply', {
    dry_run_token: dry.body.dry_run_token,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied.units, 1);
  assert.equal(applied.body.applied.kpis, 1);

  const dup = await env.http(env.fx.owner).post('/onboarding/apply', {
    dry_run_token: dry.body.dry_run_token,
  });
  assert.equal(dup.status, 400);
});

test('export job produces manifest and CSV files', async () => {
  const queued = await env.http(env.fx.owner).post('/workspace/export', {});
  assert.equal(queued.status, 200);
  const jobId = queued.body.export_job.id;
  const status = await env.http(env.fx.owner).get(`/workspace/export/${jobId}`);
  assert.equal(status.body.export_job.status, 'done');
  const dir = status.body.export_job.storage_path;
  assert.ok(fs.existsSync(dir));
  for (const file of ['people.csv', 'kpis.csv', 'projects.csv', 'manifest.json']) {
    assert.ok(fs.existsSync(`${dir}/${file}`), file);
  }
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
  assert.equal(manifest.workspace_id, env.fx.wsA.id);
});

test('usage counts agent tool calls', async () => {
  const before = await env.http(env.fx.owner).get('/admin/usage');
  const base = before.body.totals?.agent_tool_calls ?? 0;
  const res = await env.http(env.fx.owner).post('/agent/tools/portfolio_os', {
    action: 'list_orgs',
  });
  assert.equal(res.status, 200);
  const after = await env.http(env.fx.owner).get('/admin/usage');
  assert.equal(after.body.totals.agent_tool_calls, base + 1);
});

test('rate limit returns 429 after threshold', async () => {
  const prev = process.env.RATE_LIMIT_AGENT_MAX;
  process.env.RATE_LIMIT_AGENT_MAX = '2';
  _testExhaustKey(`agent:${env.fx.owner.id}`, 2);
  const res = await env.http(env.fx.owner).post('/agent/tools/portfolio_os', { action: 'list_orgs' });
  assert.equal(res.status, 429);
  if (prev === undefined) delete process.env.RATE_LIMIT_AGENT_MAX;
  else process.env.RATE_LIMIT_AGENT_MAX = prev;
});

test('audit-log lists permission denials for owner', async () => {
  await env.http(env.fx.alphaMember1).post('/projects', { name: 'x', unit_id: env.fx.alphaBranch.id });
  const log = await env.http(env.fx.owner).get('/audit-log?kind=permission.deny&limit=5');
  assert.equal(log.status, 200);
  assert.ok(log.body.entries.length >= 1);
});

test('request id header is returned', async () => {
  const res = await fetch(`${env.base}/health`, { headers: { 'x-request-id': 'test-req-phase8' } });
  assert.equal(res.headers.get('x-request-id'), 'test-req-phase8');
});
