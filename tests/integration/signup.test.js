import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

/*
 * Self-serve workspaces (migration 022): sign-up creates a person and their own workspace,
 * a signed-in person can open more, and a new workspace sees nothing of any other.
 */
let env;
before(async () => { env = await createEnv(); });
after(async () => { await env.close(); });

async function post(url, body, token) {
  const res = await fetch(env.base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(url, token) {
  const res = await fetch(env.base + url, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('sign-up creates an owner in a fresh, empty workspace', async () => {
  const out = await post('/auth/signup', {
    full_name: 'Asha Rao',
    email: 'Asha@Acme.test',
    password: 'correct-horse',
    workspace_name: 'Acme Holdings',
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.ok(out.body.token);
  assert.equal(out.body.membership.role, 'owner');
  assert.equal(out.body.membership.workspace_name, 'Acme Holdings');
  assert.equal(out.body.membership.workspace_slug, 'acme-holdings');
  assert.equal(out.body.membership.plan_code, 'pilot');
  assert.equal(out.body.workspaces.length, 1);

  const orgs = await get('/orgs', out.body.token);
  assert.equal(orgs.status, 200);
  assert.deepEqual(orgs.body.orgs, []);

  const login = await post('/auth/login', { email: 'asha@acme.test', password: 'correct-horse' });
  assert.equal(login.status, 200);
  assert.equal(login.body.membership.workspace_slug, 'acme-holdings');
});

test('sign-up rejects a taken email and a short password', async () => {
  const taken = await post('/auth/signup', {
    full_name: 'Again', email: 'asha@acme.test', password: 'correct-horse', workspace_name: 'X Co',
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'email_taken');
  const short = await post('/auth/signup', {
    full_name: 'Bo', email: 'bo@x.test', password: 'short', workspace_name: 'X Co',
  });
  assert.equal(short.status, 400);
});

test('a signed-in owner opens a second workspace and can switch back', async () => {
  const token = env.auth.signToken(env.fx.owner);
  const created = await post('/auth/workspaces', { name: 'Side Ventures' }, token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.membership.workspace_name, 'Side Ventures');
  assert.equal(created.body.membership.role, 'owner');
  assert.ok(created.body.workspaces.length >= 2);

  // The new workspace is isolated: no organisations from the original one.
  const orgs = await get('/orgs', created.body.token);
  assert.deepEqual(orgs.body.orgs, []);

  const back = await post('/auth/switch', { workspace_id: env.fx.owner.workspace_id }, created.body.token);
  assert.equal(back.status, 200);
  const original = await get('/orgs', back.body.token);
  assert.ok(original.body.orgs.length > 0);

  const again = await post('/auth/workspaces', { name: 'Side Ventures' }, token);
  assert.equal(again.status, 201);
  assert.equal(again.body.membership.workspace_slug, 'side-ventures-2');
});

test('creating a workspace needs a sign-in and a name', async () => {
  const anon = await post('/auth/workspaces', { name: 'Nope' });
  assert.equal(anon.status, 401);
  const blank = await post('/auth/workspaces', { name: ' ' }, env.auth.signToken(env.fx.owner));
  assert.equal(blank.status, 400);
});
