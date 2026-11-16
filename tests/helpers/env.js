/**
 * Per-test-file environment: a fresh migrated database, the API loaded against it, fixtures,
 * and small helpers. Each test file gets its own database, so files can run in parallel.
 */
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const api = (file) => path.join(repo, 'packages/api/src', file);

pg.types.setTypeParser(1082, (v) => v); // DATE as 'YYYY-MM-DD', same as the API

function adminUrl() {
  const url = process.env.TEST_PG_ADMIN_URL;
  if (!url) throw new Error('TEST_PG_ADMIN_URL is not set — run the suites with `npm test`.');
  return url;
}

/** Create an empty database on the test server. Returns its URL and a drop() function. */
export async function createEmptyDatabase() {
  const name = `pt_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

const urlFor = (url, user, password) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

export async function loadMigrator() {
  return import(path.join(repo, 'packages/db/scripts/migrate.js'));
}

/**
 * Full environment: migrated database + API modules + fixture data.
 * Call once per test file (in `before`) and `await env.close()` in `after`.
 */
export async function createEnv() {
  const database = await createEmptyDatabase();
  const { bootstrapDatabase } = await import(path.join(repo, 'packages/db/scripts/bootstrap.js'));
  const { runMigrations } = await loadMigrator();
  // Same layout as a real deployment: schema owned and migrated by portfolio_migrator,
  // the API connected as portfolio_app with row-level security enforced.
  await bootstrapDatabase({ adminUrl: database.url, manageRoles: false, log: () => {} });
  await runMigrations({ databaseUrl: urlFor(database.url, 'portfolio_migrator', 'migrator'), log: () => {} });
  await bootstrapDatabase({ adminUrl: database.url, manageRoles: false, log: () => {} });

  // The API reads DATABASE_URL when db.js is first imported.
  const appUrl = urlFor(database.url, 'portfolio_app', 'app');
  process.env.DATABASE_URL = appUrl;
  const db = await import(api('db.js'));
  const auth = await import(api('auth.js'));
  const { createApp } = await import(api('app.js'));
  const dates = await import(api('core/dates.js'));

  // Fixtures and assertions go through a superuser connection (sees everything, like psql).
  const admin = new pg.Pool({ connectionString: database.url, max: 4 });
  const passwords = await import(api('core/passwords.js'));
  const fx = await seedFixtures(admin, auth, passwords);

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Authenticated HTTP call as a fixture membership: http(fx.alphaManager).post('/x', body) */
  const http = (membership) => {
    const token = auth.signToken(membership);
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    return {
      get: (url) => call('GET', url),
      post: (url, body = {}) => call('POST', url, body),
      patch: (url, body = {}) => call('PATCH', url, body),
      delete: (url) => call('DELETE', url),
    };
  };

  /** A dedicated connection with an open transaction, for interleaving two operations. */
  const openTransaction = async (membership) => {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    await client.query('BEGIN');
    if (membership) {
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [membership.workspace_id ?? '']);
      await client.query(`SELECT set_config('app.role', $1, true)`, [membership.role]);
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [membership.org_id ?? '']);
      await client.query(`SELECT set_config('app.membership_id', $1, true)`, [membership.id]);
    }
    return {
      client,
      commit: async () => { await client.query('COMMIT'); await client.end(); },
      rollback: async () => { await client.query('ROLLBACK'); await client.end(); },
    };
  };

  return {
    db,
    auth,
    dates,
    fx,
    http,
    base,
    openTransaction,
    api: (file) => import(api(file)),
    appUrl,
    adminUrl: database.url,
    /** Superuser query (bypasses RLS) — for fixtures and assertions only. */
    sql: (text, params) => admin.query(text, params),
    /** Run a domain function in a scoped transaction, like a request does. */
    as: (membership, fn) => db.withSession(membership, fn),
    async close() {
      await new Promise((r) => server.close(r));
      await db.pool.end();
      await admin.end();
      await database.drop();
    },
  };
}

/** True if the promise is still pending after `ms` (i.e. it is blocked on a lock). */
export async function isBlocked(promise, ms = 400) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

/*
 * Fixture.
 *   Workspace A ("acme"):
 *     owner (portfolio owner, no org)
 *     alpha: manager ─┬─ team lead ── member1 (owns alpha.daily)
 *                     └─ member2 (owns alpha.other; NOT in the team lead's team)
 *     beta:  manager ── team lead ── member (owns beta.daily)
 *   Workspace B ("globex"): its own owner, and org gamma with a manager (owns gamma.daily)
 */
async function seedFixtures(pool, auth, passwords) {
  const pw = await passwords.hashPassword('password123');
  const c = await pool.connect();
  try {
    const one = async (text, params) => (await c.query(text, params)).rows[0];
    const useWorkspace = (id) => c.query(`SELECT set_config('app.workspace_id', $1, false)`, [id]);

    const wsA = await one(`INSERT INTO workspaces (name, slug) VALUES ('Acme Group', 'acme') RETURNING id`);
    const wsB = await one(`INSERT INTO workspaces (name, slug) VALUES ('Globex', 'globex') RETURNING id`);

    const org = (slug) =>
      one(
        `INSERT INTO organisations (slug, name, short_name, sector, descriptor) VALUES ($1,$2,$2,'Test','Test org') RETURNING id`,
        [slug, slug.toUpperCase()],
      );
    const person = async (workspaceId, name, role, orgId, parentId) => {
      const user = await one(
        `INSERT INTO users (full_name, email, password_hash) VALUES ($1,$2,$3) RETURNING id`,
        [name, `${name.toLowerCase().replace(/\s+/g, '.')}@test.local`, pw],
      );
      await c.query(`INSERT INTO workspace_members (workspace_id, user_id, workspace_role) VALUES ($1,$2,$3)`, [
        workspaceId,
        user.id,
        role === 'owner' ? 'owner' : 'member',
      ]);
      const m = await one(
        `INSERT INTO memberships (user_id, org_id, role, title, parent_id, workspace_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [user.id, orgId, role, role, parentId ?? null, workspaceId],
      );
      return auth.loadMembership(m.id);
    };
    const kpi = async (orgId, code, ownerId) => {
      const row = await one(
        `INSERT INTO kpis (org_id, code, name, unit, owned_at_level, owner_id, how_often, rollup_method,
                           target, green_at, amber_at, source_tag, rationale)
         VALUES ($1,$2,$3,'count','member',$4,'Every day','sum',10,10,8,'derived','fixture') RETURNING id`,
        [orgId, code, `KPI ${code}`, ownerId],
      );
      await c.query(`INSERT INTO kpi_goals (kpi_id, how_often, target) VALUES ($1,'Every day',10)`, [row.id]);
      return { id: row.id, code };
    };

    await useWorkspace(wsA.id);
    const alpha = await org('alpha');
    const beta = await org('beta');
    const owner = await person(wsA.id, 'Owner', 'owner', null, null);
    const alphaManager = await person(wsA.id, 'Alpha Manager', 'manager', alpha.id, null);
    const alphaLead = await person(wsA.id, 'Alpha Lead', 'team_lead', alpha.id, alphaManager.id);
    const alphaMember1 = await person(wsA.id, 'Alpha Member One', 'member', alpha.id, alphaLead.id);
    const alphaMember2 = await person(wsA.id, 'Alpha Member Two', 'member', alpha.id, alphaManager.id);
    const betaManager = await person(wsA.id, 'Beta Manager', 'manager', beta.id, null);
    const betaLead = await person(wsA.id, 'Beta Lead', 'team_lead', beta.id, betaManager.id);
    const betaMember = await person(wsA.id, 'Beta Member', 'member', beta.id, betaLead.id);
    const kpiAlpha = await kpi(alpha.id, 'alpha.daily', alphaMember1.id);
    const kpiAlphaOther = await kpi(alpha.id, 'alpha.other', alphaMember2.id);
    const kpiBeta = await kpi(beta.id, 'beta.daily', betaMember.id);

    await useWorkspace(wsB.id);
    const gamma = await org('gamma');
    const ownerB = await person(wsB.id, 'Owner B', 'owner', null, null);
    const gammaManager = await person(wsB.id, 'Gamma Manager', 'manager', gamma.id, null);
    const kpiGamma = await kpi(gamma.id, 'gamma.daily', gammaManager.id);

    await c.query(`SELECT auth.sync_units_from_legacy()`);

    const alphaOrgUnit = await one(`SELECT id FROM units WHERE legacy_org_id = $1`, [alpha.id]);
    const betaOrgUnit = await one(`SELECT id FROM units WHERE legacy_org_id = $1`, [beta.id]);
    const alphaBranch = await one(
      `INSERT INTO units (workspace_id, parent_id, type, name, short_name)
       VALUES ($1, $2, 'branch', 'Alpha North', 'NORTH') RETURNING id`,
      [wsA.id, alphaOrgUnit.id],
    );
    const betaBranch = await one(
      `INSERT INTO units (workspace_id, parent_id, type, name, short_name)
       VALUES ($1, $2, 'branch', 'Beta South', 'SOUTH') RETURNING id`,
      [wsA.id, betaOrgUnit.id],
    );
    const betaCrossTeam = await one(
      `INSERT INTO units (workspace_id, parent_id, type, name)
       VALUES ($1, $2, 'team', 'Beta cross team') RETURNING id`,
      [wsA.id, betaBranch.id],
    );
    const crossBranchManager = await person(
      wsA.id,
      'Cross Branch Manager',
      'vice_manager',
      alpha.id,
      alphaManager.id,
    );
    await c.query(`SELECT auth.sync_units_from_legacy()`);
    await c.query(`UPDATE assignments SET unit_id = $1, role = 'unit_manager' WHERE id = $2`, [
      alphaBranch.id,
      crossBranchManager.id,
    ]);

    return {
      wsA, wsB, alpha, beta, gamma,
      owner, alphaManager, alphaLead, alphaMember1, alphaMember2, betaManager, betaLead, betaMember,
      ownerB, gammaManager,
      kpiAlpha, kpiAlphaOther, kpiBeta, kpiGamma,
      alphaBranch,
      betaBranch,
      betaCrossTeam,
      crossBranchManager,
    };
  } finally {
    await c.query(`RESET app.workspace_id`).catch(() => {});
    c.release();
  }
}
