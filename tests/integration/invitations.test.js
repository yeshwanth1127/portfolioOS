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

async function alphaUnitId() {
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1`, [env.fx.alpha.id]);
  return rows[0].id;
}

test('manager can create and list pending invitations for their unit', async () => {
  const unitId = await alphaUnitId();
  const created = await env.http(env.fx.alphaManager).post('/invitations', {
    email: 'invite.me@test.local',
    unit_id: unitId,
    role: 'member',
    title: 'Analyst',
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.token);
  assert.equal(created.body.invitation.email, 'invite.me@test.local');
  assert.equal(created.body.invitation.role, 'contributor');

  const listed = await env.http(env.fx.alphaManager).get('/invitations');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.invitations.some((i) => i.id === created.body.invitation.id));
});

test('owner sees invitations across the workspace', async () => {
  const unitId = await alphaUnitId();
  await env.http(env.fx.alphaManager).post('/invitations', {
    email: 'owner-visible@test.local',
    unit_id: unitId,
    role: 'member',
  });
  const listed = await env.http(env.fx.owner).get('/invitations');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.invitations.some((i) => i.email === 'owner-visible@test.local'));
});

test('accept invitation creates membership and assignment', async () => {
  const unitId = await alphaUnitId();
  const created = await env.http(env.fx.alphaManager).post('/invitations', {
    email: 'accepted.user@test.local',
    unit_id: unitId,
    role: 'member',
    title: 'Field lead',
  });
  const accept = await fetch(`${env.base}/invitations/${created.body.invitation.id}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: env.fx.owner.workspace_id,
      token: created.body.token,
      full_name: 'Accepted User',
      password: 'password123',
      title: 'Field lead',
    }),
  });
  assert.equal(accept.status, 200);
  const body = await accept.json();
  assert.equal(body.ok, true);
  assert.equal(body.can_sign_in, true);

  const { rows } = await env.sql(
    `SELECT m.id, a.id AS assignment_id, a.unit_id, a.status
     FROM memberships m
     JOIN assignments a ON a.id = m.id
     JOIN users u ON u.id = m.user_id
     WHERE u.email = 'accepted.user@test.local'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit_id, unitId);
  assert.equal(rows[0].status, 'active');
});

test('members cannot invite', async () => {
  const unitId = await alphaUnitId();
  const res = await env.http(env.fx.alphaMember1).post('/invitations', {
    email: 'nope@test.local',
    unit_id: unitId,
    role: 'member',
  });
  assert.equal(res.status, 403);
});
