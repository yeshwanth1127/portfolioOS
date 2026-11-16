import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

/*
 * Workspace isolation (Phase 2, review P1-1 and P1-2): the owner of workspace A — who sees every
 * organisation in A — sees nothing of workspace B, cannot write into it, and no row can reference
 * a row in another workspace, even through a foreign key (FK checks bypass RLS).
 */
let env, fx, S;
before(async () => {
  env = await createEnv();
  fx = env.fx;
  S = await env.api('domain/submissions.js');
  const day = env.dates.addDays(env.dates.todayIn(), -2);
  await env.as(fx.gammaManager, (c) => S.recordNumber(c, fx.gammaManager, { kpi_code: 'gamma.daily', value: 3, period_date: day }));
  await env.as(fx.alphaMember1, (c) => S.recordNumber(c, fx.alphaMember1, { kpi_code: 'alpha.daily', value: 3, period_date: day }));
});
after(async () => { await env.close(); });

async function raw(membership, sql, params = []) {
  const tx = await env.openTransaction(membership);
  try { return (await tx.client.query(sql, params)).rows; } finally { await tx.rollback(); }
}

test('owner of A sees all of A and nothing of B — even by id', async () => {
  const orgs = (await raw(fx.owner, `SELECT slug FROM organisations ORDER BY slug`)).map((r) => r.slug);
  assert.deepEqual(orgs, ['alpha', 'beta']);
  const byId = await raw(fx.owner, `SELECT id FROM organisations WHERE id = $1`, [fx.gamma.id]);
  assert.equal(byId.length, 0);
  const subs = await raw(fx.owner, `SELECT DISTINCT org_id FROM submissions`);
  assert.ok(!subs.some((r) => r.org_id === fx.gamma.id));
  const people = await raw(fx.owner, `SELECT id FROM memberships WHERE id = $1`, [fx.gammaManager.id]);
  assert.equal(people.length, 0);
  const ws = await raw(fx.owner, `SELECT id FROM workspaces`);
  assert.deepEqual(ws.map((r) => r.id), [fx.wsA.id]);
});

test('owner of A cannot update or delete B rows by id', async () => {
  const upd = await raw(fx.owner, `UPDATE organisations SET name = 'pwned' WHERE id = $1 RETURNING id`, [fx.gamma.id]);
  assert.equal(upd.length, 0);
  const del = await raw(fx.owner, `DELETE FROM kpis WHERE id = $1 RETURNING id`, [fx.kpiGamma.id]);
  assert.equal(del.length, 0);
  const name = (await env.sql(`SELECT name FROM organisations WHERE id = $1`, [fx.gamma.id])).rows[0].name;
  assert.equal(name, 'GAMMA');
});

test("owner of A cannot insert a row labelled with B's workspace", async () => {
  const tx = await env.openTransaction(fx.owner);
  try {
    await assert.rejects(
      tx.client.query(
        `INSERT INTO organisations (workspace_id, slug, name, short_name, sector, descriptor) VALUES ($1,'x','x','x','x','x')`,
        [fx.wsB.id],
      ),
      /row-level security/,
    );
  } finally { await tx.rollback(); }
});

test("a row cannot reference another workspace's row (composite foreign keys)", async () => {
  // Even a superuser-level writer cannot attach a workspace A KPI to workspace B's organisation.
  await assert.rejects(
    env.sql(
      `INSERT INTO kpis (workspace_id, org_id, code, name, unit, owned_at_level, how_often, source_tag, rationale)
       VALUES ($1, $2, 'cross.x', 'x', 'count', 'member', 'Every day', 'derived', 'x')`,
      [fx.wsA.id, fx.gamma.id],
    ),
    /foreign key/,
  );
  await assert.rejects(
    env.sql(`UPDATE memberships SET parent_id = $1 WHERE id = $2`, [fx.gammaManager.id, fx.alphaLead.id]),
    /foreign key/,
  );
});

test('every foreign key between workspace tables includes workspace_id', async () => {
  const { rows } = await env.sql(`
    SELECT c.conname, src.relname
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE c.contype = 'f' AND src.relnamespace = 'public'::regnamespace
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = src.oid AND attname = 'workspace_id')
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = ref.oid AND attname = 'workspace_id')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k
        WHERE a.attname = 'workspace_id'
      )`);
  assert.deepEqual(rows, [], `FKs missing workspace_id: ${rows.map((r) => `${r.relname}.${r.conname}`).join(', ')}`);
});

test('every workspace table has a restrictive isolation policy and forced RLS', async () => {
  const { rows } = await env.sql(`
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid AND attname = 'workspace_id' AND NOT attisdropped)
      AND (NOT c.relforcerowsecurity OR NOT EXISTS (
        SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.permissive = 'RESTRICTIVE'
      ))`);
  assert.deepEqual(rows.map((r) => r.relname), []);
});

test('HTTP: tokens are bound to a workspace; B is invisible to A through the API', async () => {
  const a = env.http(fx.owner);
  const orgs = (await a.get('/orgs')).body.orgs.map((o) => o.slug).sort();
  assert.deepEqual(orgs, ['alpha', 'beta']);
  assert.equal((await a.get('/orgs/gamma/kpis')).status, 404);
  const subs = await env.http(fx.ownerB).get(`/submissions?org=gamma&date=${env.dates.addDays(env.dates.todayIn(), -2)}`);
  assert.equal(subs.body.submissions.length, 1);
  // a token whose workspace no longer matches the membership is rejected
  const forged = env.auth.signToken({ ...fx.owner, workspace_id: fx.wsB.id });
  const res = await fetch(`${env.base}/orgs`, { headers: { authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
});

test('a person in two workspaces logs in to one and switches to the other', async () => {
  // Owner B also joins workspace A as a member of beta.
  const ownerBUser = (await env.sql(`SELECT user_id FROM memberships WHERE id = $1`, [fx.ownerB.id])).rows[0].user_id;
  await env.sql(`INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)`, [fx.wsA.id, ownerBUser]);
  await env.sql(`INSERT INTO memberships (workspace_id, user_id, org_id, role, title) VALUES ($1,$2,$3,'member','Advisor')`, [fx.wsA.id, ownerBUser, fx.beta.id]);

  const login = await fetch(`${env.base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner.b@test.local', password: 'password123' }),
  }).then((r) => r.json());
  assert.equal(login.workspaces.length, 2);
  assert.equal(login.membership.workspace_id, fx.wsB.id, 'most senior role first (owner of B)');

  const switched = await fetch(`${env.base}/auth/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ workspace_id: fx.wsA.id }),
  }).then((r) => r.json());
  assert.equal(switched.membership.workspace_id, fx.wsA.id);
  assert.equal(switched.membership.role, 'member');
  const orgs = await fetch(`${env.base}/orgs`, { headers: { authorization: `Bearer ${switched.token}` } }).then((r) => r.json());
  assert.deepEqual(orgs.orgs.map((o) => o.slug), ['beta']);

  const refused = await fetch(`${env.base}/auth/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.auth.signToken(fx.alphaMember1)}` },
    body: JSON.stringify({ workspace_id: fx.wsB.id }),
  });
  assert.equal(refused.status, 403);
});
