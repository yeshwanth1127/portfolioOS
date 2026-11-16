import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, '../migrations');

/*
 * Forward-only migrations. Each file runs in one transaction and is recorded in
 * schema_migrations only if it succeeds. A failure stops the run and leaves the migration
 * unapplied — nothing is ever marked applied because "something already exists".
 *
 *   node migrate.js                      apply pending migrations
 *   node migrate.js --baseline <id>      adopt an existing database: record every migration up to
 *                                        <id> (e.g. 006_kpi_goals.sql) WITHOUT running it, but only
 *                                        after its check in migrations/verify/<id> returns true
 *   node migrate.js --status             list applied / pending
 */

function listMigrations(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedIds(client) {
  const { rows } = await client.query('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => r.id));
}

/** Apply pending migrations. Throws on the first failure (that migration stays unapplied). */
export async function runMigrations({ databaseUrl, dir = DEFAULT_DIR, log = console.log } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied = [];
  try {
    await ensureTable(client);
    const done = await appliedIds(client);
    const files = listMigrations(dir);

    if (done.size === 0) {
      const { rows } = await client.query(`SELECT to_regclass('public.organisations') AS org`);
      if (rows[0]?.org) {
        throw new Error(
          'This database already has the PortfolioOS schema but no migration history. ' +
            'Do not re-run migrations over it: adopt it with `node migrate.js --baseline <last applied migration>`.',
        );
      }
    }

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        e.message = `Migration ${file} failed and was rolled back (not recorded): ${e.message}`;
        throw e;
      }
      applied.push(file);
      log('Applied', file);
    }
    return applied;
  } finally {
    await client.end();
  }
}

/** Record migrations up to `upTo` as applied, each only if its verify query returns true. */
export async function baseline({ databaseUrl, upTo, dir = DEFAULT_DIR, log = console.log } = {}) {
  const files = listMigrations(dir);
  if (!files.includes(upTo)) throw new Error(`Unknown migration "${upTo}". Known: ${files.join(', ')}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const recorded = [];
  try {
    await ensureTable(client);
    const done = await appliedIds(client);
    for (const file of files.slice(0, files.indexOf(upTo) + 1)) {
      if (done.has(file)) continue;
      const verifyPath = path.join(dir, 'verify', file);
      if (!fs.existsSync(verifyPath)) {
        throw new Error(`Cannot baseline ${file}: no check at migrations/verify/${file}.`);
      }
      let ok = false;
      try {
        const res = await client.query(fs.readFileSync(verifyPath, 'utf8'));
        ok = Object.values(res.rows[0] ?? {})[0] === true;
      } catch (e) {
        throw new Error(`Cannot baseline ${file}: its check failed to run (${e.message}).`);
      }
      if (!ok) {
        throw new Error(
          `Cannot baseline ${file}: the database does not match what this migration creates. ` +
            `Nothing after ${recorded[recorded.length - 1] ?? 'the start'} was recorded.`,
        );
      }
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      recorded.push(file);
      log('Baselined', file);
    }
    return recorded;
  } finally {
    await client.end();
  }
}

export async function status({ databaseUrl, dir = DEFAULT_DIR } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureTable(client);
    const done = await appliedIds(client);
    return listMigrations(dir).map((id) => ({ id, applied: done.has(id) }));
  } finally {
    await client.end();
  }
}

async function main() {
  // Migrations run as the schema owner when MIGRATION_DATABASE_URL is set (see docs/BUILD.md F12).
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://portfolio:portfolio@localhost:5432/portfolio_os';
  const args = process.argv.slice(2);
  if (args[0] === '--baseline') {
    if (!args[1]) throw new Error('Usage: node migrate.js --baseline <migration file name>');
    await baseline({ databaseUrl, upTo: args[1] });
    console.log('Baseline complete. Run `node migrate.js` to apply anything newer.');
    return;
  }
  if (args[0] === '--status') {
    for (const m of await status({ databaseUrl })) console.log(m.applied ? 'applied ' : 'pending ', m.id);
    return;
  }
  await runMigrations({ databaseUrl });
  console.log('Migrations complete.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
