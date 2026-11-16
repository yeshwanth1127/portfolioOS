import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createEnv } from '../helpers/env.js';

/*
 * Database-level isolation (F12/F13): the app role cannot bypass row-level security, and a
 * scoped transaction only sees its own organisation — even if application code forgot a check.
 */
let env, fx;
before(async () => {
  env = await createEnv();
  fx = env.fx;
  const S = await env.api('domain/submissions.js');
  const day = env.dates.addDays(env.dates.todayIn(), -3);
  await env.as(fx.alphaMember1, (c) => S.recordNumber(c, fx.alphaMember1, { kpi_code: 'alpha.daily', value: 4, period_date: day }));
  await env.as(fx.betaMember, (c) => S.recordNumber(c, fx.betaMember, { kpi_code: 'beta.daily', value: 6, period_date: day }));
});
after(async () => { await env.close(); });

async function asRaw(membership, sql, params = []) {
  const tx = await env.openTransaction(membership);
  try {
    return (await tx.client.query(sql, params)).rows;
  } finally {
    await tx.rollback();
  }
}

test('the app role is not a superuser and cannot bypass RLS', async () => {
  const rows = await asRaw(null, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false });
});

test('without a scope, protected tables return nothing', async () => {
  for (const table of ['submissions', 'kpis', 'memberships', 'scores', 'org_periods', 'agent_sessions', 'wa_outbox']) {
    const rows = await asRaw(null, `SELECT count(*)::int AS c FROM ${table}`);
    assert.equal(rows[0].c, 0, `${table} must be invisible without a scope`);
  }
});

test('a manager sees only their own organisation, even with a raw query', async () => {
  const subs = await asRaw(fx.betaManager, `SELECT DISTINCT org_id FROM submissions`);
  assert.deepEqual(subs.map((r) => r.org_id), [fx.beta.id]);
  const kpis = await asRaw(fx.betaManager, `SELECT code FROM kpis ORDER BY code`);
  assert.deepEqual(kpis.map((r) => r.code), ['beta.daily']);
  const people = await asRaw(fx.betaManager, `SELECT DISTINCT org_id FROM memberships`);
  assert.deepEqual(people.map((r) => r.org_id), [fx.beta.id]);
});

test('a manager cannot write into another organisation', async () => {
  const tx = await env.openTransaction(fx.betaManager);
  try {
    await assert.rejects(
      tx.client.query(
        `INSERT INTO submissions (org_id, kpi_id, period_date, level, value, state) VALUES ($1,$2,'2026-01-01','manager',1,'submitted')`,
        [fx.alpha.id, fx.kpiAlpha.id],
      ),
      /row-level security/,
    );
  } finally {
    await tx.rollback();
  }
  const upd = await asRaw(fx.betaManager, `UPDATE submissions SET value = 999 WHERE org_id = $1 RETURNING id`, [fx.alpha.id]);
  assert.equal(upd.length, 0);
});

test('the owner sees every organisation', async () => {
  const subs = await asRaw(fx.owner, `SELECT DISTINCT org_id FROM submissions ORDER BY org_id`);
  assert.equal(subs.length, 2);
});

test('login lookups work without a scope, and only through the auth functions', async () => {
  const c = new pg.Client({ connectionString: env.appUrl });
  await c.connect();
  try {
    const { rows } = await c.query(`SELECT user_id FROM auth.login_candidate('alpha.manager@test.local')`);
    assert.equal(rows.length, 1);
    assert.equal((await c.query(`SELECT count(*)::int AS c FROM memberships`)).rows[0].c, 0);
  } finally {
    await c.end();
  }
});

test('passwords: login works, legacy hashes are upgraded, new hashes are scrypt', async () => {
  const legacy = (await import('crypto')).createHash('sha256').update('portfolio-os:legacy-pass-1').digest('hex');
  await env.sql(`UPDATE users SET password_hash = $1 WHERE email = 'beta.member@test.local'`, [legacy]);
  const login = (email, password) =>
    fetch(`${env.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

  assert.equal((await login('beta.member@test.local', 'wrong-password')).status, 401);
  const ok = await login('beta.member@test.local', 'legacy-pass-1');
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
  const stored = (await env.sql(`SELECT password_hash FROM users WHERE email = 'beta.member@test.local'`)).rows[0].password_hash;
  assert.match(stored, /^scrypt\$/);
  assert.equal((await login('beta.member@test.local', 'legacy-pass-1')).status, 200, 'still works after upgrade');
  assert.equal((await login('nobody@test.local', 'whatever-123')).status, 401);
  assert.equal((await login('ALPHA.MANAGER@test.local', 'password123')).status, 200, 'email is case-insensitive');
});

test('a person added by a manager has no password until one is set', async () => {
  const res = await env.http(fx.alphaManager).post('/orgs/alpha/people', { full_name: 'New Hire', email: 'new.hire@test.local', role: 'member' });
  assert.equal(res.status, 200);
  assert.equal(res.body.can_sign_in, false);
  const row = (await env.sql(`SELECT password_hash FROM users WHERE email = 'new.hire@test.local'`)).rows[0];
  assert.equal(row.password_hash, null);
});

test('secrets: production refuses defaults, development only warns', async () => {
  const { secretProblems } = await env.api('core/config.js');
  assert.deepEqual(secretProblems(['A'], { A: 'x'.repeat(40) }), []);
  assert.equal(secretProblems(['A'], {}).length, 1);
  assert.match(secretProblems(['A'], { A: 'dev-runner-secret' })[0], /default/);
  assert.match(secretProblems(['A'], { A: 'short' })[0], /shorter/);
});
