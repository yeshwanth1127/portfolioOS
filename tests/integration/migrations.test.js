import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import pg from 'pg';
import { createEmptyDatabase, loadMigrator } from '../helpers/env.js';

const quiet = () => {};
async function query(url, text) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(text)).rows; } finally { await c.end(); }
}
function tempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

test('all migrations apply to an empty database, and a second run is a no-op', async () => {
  const database = await createEmptyDatabase();
  try {
    const { runMigrations } = await loadMigrator();
    const first = await runMigrations({ databaseUrl: database.url, log: quiet });
    assert.ok(first.includes('001_schema.sql') && first.includes('007_org_periods.sql'));
    assert.deepEqual(await runMigrations({ databaseUrl: database.url, log: quiet }), []);
  } finally { await database.drop(); }
});

test('a migration that fails halfway is rolled back and not recorded', async () => {
  const database = await createEmptyDatabase();
  try {
    const { runMigrations } = await loadMigrator();
    const dir = tempMigrations({
      '001_ok.sql': 'CREATE TABLE a (id int);',
      // creates b, then collides with the existing table a → the old runner marked this "applied"
      '002_conflict.sql': 'CREATE TABLE b (id int); CREATE TABLE a (id int);',
      '003_never.sql': 'CREATE TABLE c (id int);',
    });
    await assert.rejects(runMigrations({ databaseUrl: database.url, dir, log: quiet }), /002_conflict\.sql failed/);
    const applied = (await query(database.url, 'SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id);
    assert.deepEqual(applied, ['001_ok.sql']);
    const tables = await query(database.url, `SELECT to_regclass('public.b') AS b, to_regclass('public.c') AS c`);
    assert.equal(tables[0].b, null, 'partial work from the failed migration must be rolled back');
    assert.equal(tables[0].c, null, 'later migrations must not run');
  } finally { await database.drop(); }
});

test('a database with schema but no history is refused, then adopted with a verified baseline', async () => {
  const database = await createEmptyDatabase();
  try {
    const { runMigrations, baseline } = await loadMigrator();
    await runMigrations({ databaseUrl: database.url, log: quiet });
    await query(database.url, 'DELETE FROM schema_migrations'); // e.g. a reused Docker volume

    await assert.rejects(runMigrations({ databaseUrl: database.url, log: quiet }), /--baseline/);

    const files = fs.readdirSync(path.resolve('packages/db/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const recorded = await baseline({ databaseUrl: database.url, upTo: files.at(-1), log: quiet });
    assert.equal(recorded.length, files.length);
    assert.deepEqual(await runMigrations({ databaseUrl: database.url, log: quiet }), []);
  } finally { await database.drop(); }
});

test('baseline refuses a database that does not match the migration', async () => {
  const database = await createEmptyDatabase();
  try {
    const { runMigrations, baseline } = await loadMigrator();
    await runMigrations({ databaseUrl: database.url, log: quiet });
    await query(database.url, 'DELETE FROM schema_migrations');
    await query(database.url, 'DROP TABLE kpi_goals CASCADE'); // what 006 creates

    await assert.rejects(
      baseline({ databaseUrl: database.url, upTo: '009_enforce_rls.sql', log: quiet }),
      /Cannot baseline 006_kpi_goals\.sql/,
    );
    const applied = (await query(database.url, 'SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id);
    assert.equal(applied.at(-1), '005_manager_team_lead_roles.sql');
  } finally { await database.drop(); }
});
