#!/usr/bin/env node
/**
 * Post-migration workspace reconciliation (Phase 2 Track A).
 *
 *   node sona-workspace-reconcile.js --help
 *   node sona-workspace-reconcile.js --dry-run
 *   node sona-workspace-reconcile.js --capture-baseline /tmp/pre-010.json   # before 010_workspaces.sql
 *   node sona-workspace-reconcile.js --baseline /tmp/pre-010.json           # after 010 (counts + checksums)
 *
 * Uses MIGRATION_DATABASE_URL or DATABASE_URL. Prefer portfolio_migrator (BYPASSRLS) so counts see every row.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE_TABLES = [
  'organisations',
  'memberships',
  'revenue_lines',
  'kpis',
  'kpi_goals',
  'kpi_audit',
  'activity_entries',
  'submissions',
  'signoffs',
  'org_periods',
  'scores',
  'amendments',
  'profile_sections',
  'case_studies',
  'partnerships',
  'org_links',
  'escalations',
  'agent_sessions',
  'agent_tool_calls',
  'agent_pending_confirms',
  'wa_outbox',
  'jobs',
  'calendar_events',
  'calendar_event_participants',
  'workspace_members',
  'whatsapp_connections',
];

/** Columns fingerprinted for checksums (workspace_id intentionally omitted). */
const CHECKSUM_TABLES = {
  kpis: `md5(concat_ws('|', id::text, org_id::text, code, name, unit, owned_at_level::text, how_often::text, source_tag::text))`,
  submissions: `md5(concat_ws('|', id::text, org_id::text, kpi_id::text, period_date::text, level::text, state::text))`,
  scores: `md5(concat_ws('|', id::text, org_id::text, kpi_id::text, period_date::text, coalesce(value::text,''), rag::text))`,
  org_periods: `md5(concat_ws('|', org_id::text, period_date::text, status))`,
  organisations: `md5(concat_ws('|', id::text, slug, name, short_name))`,
};

function usage() {
  console.log(`Sona workspace reconciliation (migration 010_workspaces.sql)

Usage:
  node sona-workspace-reconcile.js [options]

Options:
  --help                 Show this help
  --dry-run              Run checks but always exit 0 (prints failures)
  --expect-sona          Require a workspace with slug "sona" (default: on)
  --no-expect-sona       Skip the Sona slug requirement (multi-workspace dev DBs)
  --capture-baseline F   Write row counts + checksums to F (run before 010)
  --baseline F           Compare current DB to F (run after 010)

Environment:
  MIGRATION_DATABASE_URL   Preferred (portfolio_migrator)
  DATABASE_URL             Fallback

See docs/SONA_MIGRATION.md`);
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    expectSona: true,
    captureBaseline: null,
    baseline: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { ...opts, help: true };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--expect-sona') opts.expectSona = true;
    else if (a === '--no-expect-sona') opts.expectSona = false;
    else if (a === '--capture-baseline') {
      opts.captureBaseline = argv[++i];
      if (!opts.captureBaseline) throw new Error('--capture-baseline requires a file path');
    } else if (a === '--baseline') {
      opts.baseline = argv[++i];
      if (!opts.baseline) throw new Error('--baseline requires a file path');
    } else throw new Error(`Unknown option: ${a} (try --help)`);
  }
  return opts;
}

function databaseUrl() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL');
  return url;
}

async function tableExists(client, name) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
  return rows[0]?.ok === true;
}

async function hasWorkspaceColumn(client, table) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'workspace_id'
     ) AS ok`,
    [table],
  );
  return rows[0]?.ok === true;
}

async function countTable(client, table) {
  const { rows } = await client.query(`SELECT count(*)::bigint AS n FROM ${quoteIdent(table)}`);
  return BigInt(rows[0].n);
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

async function tableChecksum(client, table, expr) {
  const { rows } = await client.query(`
    SELECT md5(coalesce(string_agg(digest, '' ORDER BY ord), '')) AS checksum
    FROM (
      SELECT ${expr} AS digest, row_number() OVER ()::text AS ord
      FROM ${quoteIdent(table)}
    ) s`);
  return rows[0]?.checksum ?? crypto.createHash('md5').update('').digest('hex');
}

export async function captureBaseline(client, { quiet = false } = {}) {
  const tables = {};
  for (const t of WORKSPACE_TABLES) {
    if (!(await tableExists(client, t))) continue;
    if (!quiet && (await hasWorkspaceColumn(client, t))) {
      console.warn(`warn: ${t} already has workspace_id — baseline counts are post-workspace shape`);
    }
    tables[t] = Number(await countTable(client, t));
  }
  const checksums = {};
  for (const [t, expr] of Object.entries(CHECKSUM_TABLES)) {
    if (!(await tableExists(client, t))) continue;
    checksums[t] = await tableChecksum(client, t, expr);
  }
  return {
    captured_at: new Date().toISOString(),
    migration: '010_workspaces.sql',
    tables,
    checksums,
  };
}

export async function integrityChecks(client, { expectSona }) {
  const failures = [];

  const mig = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'organisations' AND column_name = 'workspace_id') AS ok`,
  );
  if (!mig.rows[0]?.ok) {
    failures.push('organisations.workspace_id missing — run 010_workspaces.sql first');
    return failures;
  }

  let sonaId = null;
  if (expectSona) {
    const { rows } = await client.query(`SELECT id, slug FROM workspaces WHERE slug = 'sona'`);
    if (rows.length === 0) failures.push('no workspace with slug "sona" (legacy cutover expectation)');
    else if (rows.length > 1) failures.push('multiple workspaces named slug sona');
    else sonaId = rows[0].id;
  }

  for (const t of WORKSPACE_TABLES) {
    if (!(await tableExists(client, t))) continue;
    if (!(await hasWorkspaceColumn(client, t))) continue;
    const nulls = await client.query(
      `SELECT count(*)::bigint AS n FROM ${quoteIdent(t)} WHERE workspace_id IS NULL`,
    );
    if (BigInt(nulls.rows[0].n) > 0n) failures.push(`${t}: ${nulls.rows[0].n} rows with NULL workspace_id`);

    const distinct = await client.query(
      `SELECT count(DISTINCT workspace_id)::bigint AS n FROM ${quoteIdent(t)}`,
    );
    if (expectSona && sonaId && BigInt(distinct.rows[0].n) > 1n) {
      failures.push(`${t}: rows span more than one workspace_id (expected single Sona tenant)`);
    }
  }

  if (sonaId) {
    const { rows: orphanUsers } = await client.query(
      `SELECT count(DISTINCT m.user_id)::bigint AS n
       FROM memberships m
       LEFT JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = m.user_id
       WHERE wm.user_id IS NULL`,
    );
    if (BigInt(orphanUsers[0].n) > 0n) {
      failures.push(`${orphanUsers[0].n} membership user(s) missing matching workspace_members row`);
    }

    const orgCnt = await client.query(`SELECT count(*)::bigint AS n FROM organisations WHERE workspace_id <> $1`, [
      sonaId,
    ]);
    if (BigInt(orgCnt.rows[0].n) > 0n) failures.push(`${orgCnt.rows[0].n} organisations outside Sona workspace`);

    const kpiCnt = await client.query(`SELECT count(*)::bigint AS n FROM kpis WHERE workspace_id <> $1`, [sonaId]);
    if (BigInt(kpiCnt.rows[0].n) > 0n) failures.push(`${kpiCnt.rows[0].n} KPIs outside Sona workspace`);
  }

  const { rows: badFk } = await client.query(`
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
  if (badFk.length) {
    failures.push(
      `foreign keys missing workspace_id: ${badFk.map((r) => `${r.relname}.${r.conname}`).join(', ')}`,
    );
  }

  return failures;
}

export async function compareBaseline(client, baseline, { expectSona }) {
  const failures = [];
  const current = await captureBaseline(client, { quiet: true });

  for (const [t, expected] of Object.entries(baseline.tables ?? {})) {
    const now = current.tables[t];
    if (now === undefined) {
      failures.push(`table ${t}: missing in current database`);
      continue;
    }
    if (now !== expected) failures.push(`table ${t}: count ${now} !== baseline ${expected}`);
  }

  for (const [t, expected] of Object.entries(baseline.checksums ?? {})) {
    const now = current.checksums[t];
    if (!now) {
      failures.push(`checksum ${t}: table missing`);
      continue;
    }
    if (now !== expected) failures.push(`checksum ${t}: ${now} !== baseline ${expected}`);
  }

  failures.push(...(await integrityChecks(client, { expectSona })));
  return { failures, current };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    if (opts.captureBaseline) {
      const snap = await captureBaseline(client);
      fs.mkdirSync(path.dirname(path.resolve(opts.captureBaseline)), { recursive: true });
      fs.writeFileSync(opts.captureBaseline, `${JSON.stringify(snap, null, 2)}\n`);
      console.log(`Wrote baseline: ${opts.captureBaseline}`);
      console.log(`  tables: ${Object.keys(snap.tables).length}, checksums: ${Object.keys(snap.checksums).length}`);
      return;
    }

    if (opts.baseline) {
      const raw = fs.readFileSync(opts.baseline, 'utf8');
      const baseline = JSON.parse(raw);
      const { failures } = await compareBaseline(client, baseline, opts);
      return finish(failures, opts);
    }

    const failures = await integrityChecks(client, opts);
    const counts = {};
    for (const t of WORKSPACE_TABLES) {
      if (!(await tableExists(client, t))) continue;
      if (!(await hasWorkspaceColumn(client, t))) continue;
      counts[t] = Number(await countTable(client, t));
    }
    console.log('Workspace table row counts:');
    for (const [t, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${t}: ${n}`);
    }
    return finish(failures, opts);
  } finally {
    await client.end();
  }
}

function finish(failures, opts) {
  if (failures.length === 0) {
    console.log('OK: Sona workspace reconciliation passed.');
    return;
  }
  console.error('Reconciliation failures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (opts.dryRun) {
    console.log('(dry-run: exiting 0)');
    return;
  }
  process.exitCode = 1;
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
