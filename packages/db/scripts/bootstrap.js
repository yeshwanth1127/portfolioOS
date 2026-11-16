import { pathToFileURL } from 'url';
import pg from 'pg';

/*
 * Database roles (docs/BUILD.md § 4.12). Run as a superuser, once per database and again after
 * migrations that add schemas. Idempotent.
 *
 *   portfolio_migrator  owns the schema and runs migrations (BYPASSRLS so data migrations see all rows)
 *   portfolio_app       what the API, gateway and runner connect as: no superuser, no BYPASSRLS,
 *                       data access only — row-level security applies to it
 *
 *   ADMIN_DATABASE_URL=postgres://<superuser>@host/portfolio_os \
 *   MIGRATOR_PASSWORD=… APP_PASSWORD=… node bootstrap.js [--adopt-from <old owner role>]
 *
 * --adopt-from moves ownership of existing objects (e.g. a database first created and migrated
 * as the Docker superuser) to portfolio_migrator.
 */

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

export async function bootstrapDatabase({ adminUrl, migratorPassword, appPassword, adoptFrom = null, manageRoles = true, log = console.log }) {
  if (manageRoles && (!migratorPassword || !appPassword)) throw new Error('MIGRATOR_PASSWORD and APP_PASSWORD are required.');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db, rolsuper FROM pg_roles WHERE rolname = current_user');
    if (!rows[0]?.rolsuper) throw new Error('bootstrap must run as a superuser');
    const db = rows[0].db;

    const roles = [
      ['portfolio_migrator', migratorPassword, 'LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE'],
      ['portfolio_app', appPassword, 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
    ];
    for (const [role, password, attrs] of manageRoles ? roles : []) {
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
      await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${ident(role)} WITH ${attrs} PASSWORD ${literal(password)}`);
    }

    await client.query(`ALTER DATABASE ${ident(db)} OWNER TO portfolio_migrator`);
    if (adoptFrom && adoptFrom !== 'portfolio_migrator') {
      // Object by object: REASSIGN OWNED cannot be used when the old owner is the bootstrap
      // superuser (it also owns system objects).
      const owned = await client.query(
        `SELECT format('ALTER %s %s OWNER TO portfolio_migrator',
                  CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                  format('%I.%I', n.nspname, c.relname)) AS sql
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
            AND pg_get_userbyid(c.relowner) = $1
            AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
         UNION ALL
         SELECT format('ALTER TYPE %I.%I OWNER TO portfolio_migrator', n.nspname, t.typname)
           FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname IN ('public', 'auth') AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) = $1
            AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
         UNION ALL
         SELECT format('ALTER FUNCTION %s OWNER TO portfolio_migrator', p.oid::regprocedure)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('public', 'auth') AND pg_get_userbyid(p.proowner) = $1
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         UNION ALL
         SELECT format('ALTER SCHEMA %I OWNER TO portfolio_migrator', n.nspname)
           FROM pg_namespace n WHERE n.nspname = 'auth' AND pg_get_userbyid(n.nspowner) = $1`,
        [adoptFrom],
      );
      for (const { sql } of owned.rows) await client.query(sql);
      log(`[bootstrap] adopted ${owned.rows.length} objects from ${adoptFrom}`);
    }
    await client.query('ALTER SCHEMA public OWNER TO portfolio_migrator');
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION portfolio_migrator`);

    const statements = [
      'GRANT CONNECT ON DATABASE ' + ident(db) + ' TO portfolio_app',
      'GRANT USAGE ON SCHEMA public, auth TO portfolio_app',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portfolio_app',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO portfolio_app',
      'REVOKE ALL ON TABLE schema_migrations FROM portfolio_app',
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO portfolio_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO portfolio_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO portfolio_app',
      'ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA auth REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      'ALTER DEFAULT PRIVILEGES FOR ROLE portfolio_migrator IN SCHEMA auth GRANT EXECUTE ON FUNCTIONS TO portfolio_app',
    ];
    const hasMigrations = (await client.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
    for (const sql of statements) {
      if (!hasMigrations && sql.includes('schema_migrations')) continue;
      await client.query(sql);
    }
    log(`[bootstrap] ${db}: roles portfolio_migrator / portfolio_app ready`);
  } finally {
    await client.end();
  }
}

/** Replace user/password in a URL — e.g. derive the app and migrator URLs from the admin URL. */
export function urlAs(baseUrl, user, password) {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const adoptIdx = args.indexOf('--adopt-from');
  bootstrapDatabase({
    adminUrl: process.env.ADMIN_DATABASE_URL,
    migratorPassword: process.env.MIGRATOR_PASSWORD,
    appPassword: process.env.APP_PASSWORD,
    adoptFrom: adoptIdx >= 0 ? args[adoptIdx + 1] : null,
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
