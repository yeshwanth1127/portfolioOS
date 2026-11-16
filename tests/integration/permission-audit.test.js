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

test('HTTP role-gate denial writes audit_log row', async () => {
  const res = await env.http(env.fx.alphaMember1).post('/projects', {
    name: 'Blocked',
    unit_id: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(res.status, 403);

  const { rows } = await env.sql(
    `SELECT kind, payload->>'action' AS action, payload->>'channel' AS channel
     FROM audit_log
     WHERE actor_id = $1 AND kind = 'permission.deny'
     ORDER BY id DESC LIMIT 1`,
    [env.fx.alphaMember1.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'project.edit');
  assert.equal(rows[0].channel, 'http');
});

test('agent tool denial writes audit_log row', async () => {
  const res = await env.http(env.fx.alphaMember1).post('/agent/tools/portfolio_os', {
    action: 'create_project',
    name: 'X',
    unit_id: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.error?.code, 'forbidden');

  const { rows } = await env.sql(
    `SELECT payload->>'tool' AS tool, payload->>'channel' AS channel
     FROM audit_log
     WHERE actor_id = $1 AND kind = 'permission.deny' AND payload->>'tool' = 'create_project'
     ORDER BY id DESC LIMIT 1`,
    [env.fx.alphaMember1.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'agent');
});
