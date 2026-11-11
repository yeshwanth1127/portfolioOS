import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '../migrations');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://portfolio:portfolio@localhost:5432/portfolio_os';

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const id = file;
    const { rows } = await client.query(
      'SELECT 1 FROM schema_migrations WHERE id = $1',
      [id],
    );
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      console.log('Applied', file);
    } catch (e) {
      await client.query('ROLLBACK');
      // Docker volume reuse: schema already present but schema_migrations empty.
      const already =
        e.code === '42710' ||
        e.code === '42P07' ||
        /already exists/i.test(e.message ?? '');
      if (already) {
        const { rows: present } = await client.query(
          `SELECT to_regclass('public.organisations') AS org`,
        );
        if (present[0]?.org) {
          await client.query(
            'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING',
            [id],
          );
          console.log('Baseline skip (schema already present):', file);
          continue;
        }
      }
      throw e;
    }
  }

  await client.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
