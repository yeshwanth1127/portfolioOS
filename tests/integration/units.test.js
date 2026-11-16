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

async function countExpectation() {
  const { rows } = await env.sql(`
    SELECT count(*)::int AS c
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.role <> 'owner'
      AND m.state <> 'inactive'
      AND u.is_named = true
      AND u.status = 'active'
  `);
  return rows[0].c;
}

test('migration backfill: active named non-owner memberships match assignments', async () => {
  const expected = await countExpectation();
  const { rows } = await env.sql(`
  SELECT count(*)::int AS c FROM assignments WHERE status = 'active' AND unit_id IS NOT NULL
`);
  assert.equal(rows[0].c, expected);
  const { rows: idRows } = await env.sql(`
    SELECT count(*)::int AS c
    FROM assignments a
    JOIN memberships m ON m.id = a.id AND m.id = a.legacy_membership_id
  `);
  assert.equal(idRows[0].c, expected);
});

test('workspace isolation: tokens only see units in their workspace', async () => {
  const a = await env.http(env.fx.owner).get('/units/tree');
  assert.equal(a.status, 200);
  const slugs = a.body.tree.map((n) => n.legacy_org_id).sort();
  assert.deepEqual(slugs, [env.fx.alpha.id, env.fx.beta.id].sort());

  const b = await env.http(env.fx.ownerB).get('/units/tree');
  assert.equal(b.status, 200);
  assert.equal(b.body.tree.length, 1);
  assert.equal(b.body.tree[0].legacy_org_id, env.fx.gamma.id);
});

test('manager sees only their organisation unit subtree', async () => {
  const res = await env.http(env.fx.alphaManager).get('/units/tree');
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'organisation');
  assert.equal(res.body.tree.length, 1);
  assert.equal(res.body.tree[0].legacy_org_id, env.fx.alpha.id);
  assert.equal(res.body.tree[0].type, 'organisation');
  assert.ok(!res.body.tree.some((n) => n.legacy_org_id === env.fx.beta.id));
});

test('owner sees full workspace tree', async () => {
  const res = await env.http(env.fx.owner).get('/units');
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'workspace');
  assert.equal(res.body.tree.length, 2);
});

test('people list exposes assignment_id and unit_id', async () => {
  const res = await env.http(env.fx.owner).get('/orgs/alpha/people');
  assert.equal(res.status, 200);
  const lead = res.body.people.find((p) => p.id === env.fx.alphaLead.id);
  assert.ok(lead);
  assert.equal(lead.assignment_id, env.fx.alphaLead.id);
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1`, [env.fx.alpha.id]);
  assert.equal(lead.unit_id, rows[0].id);
});

test('people mutations dual-write assignments', async () => {
  const created = await env.http(env.fx.alphaManager).post('/orgs/alpha/people', {
    full_name: 'Dual Write',
    email: 'dual.write@test.local',
    role: 'member',
    title: 'Operator',
  });
  assert.equal(created.status, 200);
  const personId = created.body.id;
  const { rows: afterCreate } = await env.sql(
    `SELECT role, title, status FROM assignments WHERE id = $1`,
    [personId],
  );
  assert.equal(afterCreate[0].role, 'contributor');
  assert.equal(afterCreate[0].title, 'Operator');
  assert.equal(afterCreate[0].status, 'active');

  const patched = await env.http(env.fx.alphaManager).patch(`/people/${personId}`, { title: 'Senior operator' });
  assert.equal(patched.status, 200);
  const { rows: afterPatch } = await env.sql(`SELECT title FROM assignments WHERE id = $1`, [personId]);
  assert.equal(afterPatch[0].title, 'Senior operator');

  const removed = await env.http(env.fx.alphaManager).delete(`/people/${personId}`);
  assert.equal(removed.status, 200);
  const { rows: afterRemove } = await env.sql(`SELECT status FROM assignments WHERE id = $1`, [personId]);
  assert.equal(afterRemove[0].status, 'inactive');
});

async function alphaOrgUnitId() {
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1`, [env.fx.alpha.id]);
  return rows[0].id;
}

test('owner creates branch under organisation unit', async () => {
  const parentId = await alphaOrgUnitId();
  const res = await env.http(env.fx.owner).post('/units', {
    parent_id: parentId,
    type: 'branch',
    name: 'Chennai',
    short_name: 'CHN',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.unit.type, 'branch');
  assert.equal(res.body.unit.parent_id, parentId);
  const { rows } = await env.sql(`SELECT name, short_name FROM units WHERE id = $1`, [res.body.unit.id]);
  assert.equal(rows[0].name, 'Chennai');
  assert.equal(rows[0].short_name, 'CHN');
});

test('manager in org can create team under organisation unit', async () => {
  const parentId = await alphaOrgUnitId();
  const res = await env.http(env.fx.alphaManager).post('/units', {
    parent_id: parentId,
    type: 'team',
    name: 'Field ops',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.unit.type, 'team');
});

test('cross-workspace create under foreign parent is forbidden', async () => {
  const parentId = await alphaOrgUnitId();
  const res = await env.http(env.fx.ownerB).post('/units', {
    parent_id: parentId,
    type: 'team',
    name: 'Intruder',
  });
  assert.equal(res.status, 403);
});

test('manager cannot add structure in another org', async () => {
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1`, [env.fx.beta.id]);
  const res = await env.http(env.fx.alphaManager).post('/units', {
    parent_id: rows[0].id,
    type: 'department',
    name: 'Cross org',
  });
  assert.equal(res.status, 403);
});

test('PATCH /units/:id renames and sets status', async () => {
  const parentId = await alphaOrgUnitId();
  const created = await env.http(env.fx.owner).post('/units', {
    parent_id: parentId,
    type: 'department',
    name: 'Ops',
  });
  const unitId = created.body.unit.id;
  const patched = await env.http(env.fx.alphaManager).patch(`/units/${unitId}`, {
    name: 'Operations',
    short_name: 'OPS',
    status: 'inactive',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.unit.name, 'Operations');
  assert.equal(patched.body.unit.short_name, 'OPS');
  assert.equal(patched.body.unit.status, 'inactive');
});

function flattenTree(nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

test('exit gate: secondary assignment on another branch (POST /assignments)', async () => {
  const { rows: before } = await env.sql(
    `SELECT count(*)::int AS c FROM memberships WHERE user_id = $1 AND workspace_id = $2 AND state = 'active'`,
    [env.fx.crossBranchManager.user_id, env.fx.wsA.id],
  );
  const created = await env.http(env.fx.owner).post('/assignments', {
    user_id: env.fx.crossBranchManager.user_id,
    unit_id: env.fx.betaCrossTeam.id,
    role: 'contributor',
    title: 'Cross-branch contributor',
    is_primary: false,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.memberships_unchanged, true);
  assert.equal(created.body.assignment.is_primary, false);

  const { rows: after } = await env.sql(
    `SELECT count(*)::int AS c FROM memberships WHERE user_id = $1 AND workspace_id = $2 AND state = 'active'`,
    [env.fx.crossBranchManager.user_id, env.fx.wsA.id],
  );
  assert.equal(after[0].c, before[0].c);

  const { rows: assignmentRows } = await env.sql(
    `SELECT count(*)::int AS c FROM assignments
     WHERE user_id = $1 AND workspace_id = $2 AND status = 'active'`,
    [env.fx.crossBranchManager.user_id, env.fx.wsA.id],
  );
  assert.equal(assignmentRows[0].c, 2);

  const tree = await env.http(env.fx.crossBranchManager).get('/units/tree');
  assert.equal(tree.status, 200);
  assert.equal(tree.body.scope, 'assignments');
  const ids = new Set(flattenTree(tree.body.tree).map((u) => u.id));
  assert.ok(ids.has(env.fx.alphaBranch.id));
  assert.ok(ids.has(env.fx.betaCrossTeam.id));

  const foreign = await env.http(env.fx.crossBranchManager).post('/assignments', {
    user_id: env.fx.crossBranchManager.user_id,
    unit_id: (
      await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1`, [env.fx.gamma.id])
    ).rows[0].id,
    role: 'contributor',
    is_primary: false,
  });
  assert.ok([403, 404].includes(foreign.status), `expected forbidden or not found, got ${foreign.status}`);

  const day = env.dates.todayIn();
  const kpiSubmit = await env.http(env.fx.alphaMember1).post('/submissions', {
    kpi_code: env.fx.kpiAlpha.code,
    period_date: day,
    value: 7,
  });
  assert.equal(kpiSubmit.status, 200);
});

test('branch type must sit under organisation', async () => {
  const parentId = await alphaOrgUnitId();
  const team = await env.http(env.fx.owner).post('/units', {
    parent_id: parentId,
    type: 'team',
    name: 'Nested team',
  });
  const res = await env.http(env.fx.owner).post('/units', {
    parent_id: team.body.unit.id,
    type: 'branch',
    name: 'Invalid branch',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /branch must be under an organisation/i);
});
