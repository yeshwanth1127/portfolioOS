/*
 * Simulate a workspace that has been live for weeks, so dashboards, reports,
 * the calendar and the agent have realistic history. For testing and demos only.
 *
 *   npm run db:simulate                              45 days ending today, Sona workspace
 *   npm run db:simulate -- --days 60 --seed 7
 *   npm run db:simulate -- --replace                 wipe the previous simulation, run again
 *   npm run db:simulate -- --reset                   remove everything a simulation added
 *   options: --workspace <slug>   --no-people (no simulated staff)   --no-today
 *
 * Every organisation gets:
 *   structure   two teams under the organisation unit, each with a team lead and 3–4 members
 *               (simulated staff, password "password123"); KPIs spread across the team
 *   targets     goals filled for KPIs that had none
 *   daily work  for every person who is in: Monday planning, tasks moving todo → in progress →
 *               review → done (or back for changes), comments, reviews, notifications,
 *               Friday project updates, milestones met or missed
 *   numbers     KPI numbers entered by their owners at the KPI's cadence, approved by the lead
 *               or manager, days locked (some next morning, a few left open) and scored by the
 *               app's own scoring; three bad days in a row raise an escalation to the owner
 *   calendar    weekly organisation reviews, monthly portfolio review, visits — past and the
 *               next two weeks
 *   presence    attendance (clock in / out, leave, missed clock-outs), sign-ins and sign-outs
 * Today is simulated up to the current time, with the day still open.
 *
 * Connects as the Postgres superuser (writes history past row-level security):
 * ADMIN_DATABASE_URL, else DATABASE_URL. Everything added is recorded in sim.registry, so
 * --reset removes exactly that and puts changed KPI goals and owners back.
 */
import pg from 'pg';
import { pathToFileURL } from 'url';
import { runSimulation } from './simulate/engine.js';
import { resetSimulation } from './simulate/reset.js';

pg.types.setTypeParser(1082, (v) => v);

function parseArgs(argv) {
  const out = { days: 45, seed: 42, workspace: null, reset: false, replace: false, people: true, today: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') out.days = Math.max(7, Math.min(180, Number(argv[++i]) || 45));
    else if (a === '--seed') out.seed = Number(argv[++i]) || 42;
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--reset') out.reset = true;
    else if (a === '--replace') out.replace = true;
    else if (a === '--no-people') out.people = false;
    else if (a === '--no-today') out.today = false;
  }
  return out;
}

export async function simulate(databaseUrl, opts) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const q = (text, params) => db.query(text, params);
  try {
    const { rows: who } = await q(`SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user`);
    if (!who[0]?.ok) {
      throw new Error('Connect as the Postgres superuser (ADMIN_DATABASE_URL, or the portfolio superuser URL in .env).');
    }
    const { rows: wsRows } = opts.workspace
      ? await q(`SELECT id, name, slug, timezone FROM workspaces WHERE slug = $1`, [opts.workspace])
      : await q(
          `SELECT w.id, w.name, w.slug, w.timezone FROM workspaces w
           ORDER BY (w.slug = 'sona') DESC, (SELECT count(*) FROM organisations o WHERE o.workspace_id = w.id) DESC LIMIT 1`,
        );
    const ws = wsRows[0];
    if (!ws) throw new Error('Workspace not found.');
    await q(`SELECT set_config('app.workspace_id', $1, false)`, [ws.id]);
    await q(`SELECT set_config('app.role', 'system', false)`);
    await q(`CREATE SCHEMA IF NOT EXISTS sim`);
    await q(`CREATE TABLE IF NOT EXISTS sim.registry (
      id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, kind text NOT NULL, ref jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);

    await q('BEGIN');
    if (opts.reset || opts.replace) await resetSimulation(q, ws);
    if (opts.reset) {
      await q('COMMIT');
      return { reset: true, workspace: ws.name };
    }
    const { rows: existing } = await q(`SELECT count(*)::int AS n FROM sim.registry WHERE workspace_id = $1`, [ws.id]);
    if (existing[0].n) throw new Error(`${ws.name} already has simulated data. Use --replace (or --reset).`);
    const summary = await runSimulation(db, ws, opts);
    await q('COMMIT');
    return summary;
  } catch (e) {
    await q('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set ADMIN_DATABASE_URL (or DATABASE_URL) to a superuser connection.');
    process.exit(1);
  }
  const started = Date.now();
  simulate(url, parseArgs(process.argv.slice(2)))
    .then((out) => console.log(JSON.stringify({ ...out, seconds: Math.round((Date.now() - started) / 1000) }, null, 2)))
    .catch((e) => {
      console.error(`[simulate] ${e.message}`);
      process.exit(1);
    });
}
