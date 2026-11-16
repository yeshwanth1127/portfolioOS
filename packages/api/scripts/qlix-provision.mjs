#!/usr/bin/env node
/*
 * Give existing workspaces their Qlix org + agents (the same code new workspaces use).
 *
 *   node --env-file=../../.env scripts/qlix-provision.mjs --workspace sona
 *   node --env-file=../../.env scripts/qlix-provision.mjs --all
 *   node --env-file=../../.env scripts/qlix-provision.mjs --status
 *
 * Safe to re-run: finished workspaces are skipped, half-finished ones resume.
 */
import { pool, query, withSession } from '../src/db.js';
import { provisionWorkspace, qlixStatus } from '../src/modules/qlix/provision.js';
import { qlixConfigured } from '../src/modules/qlix/client.js';

const args = process.argv.slice(2);
const slugArg = args[args.indexOf('--workspace') + 1];
const all = args.includes('--all');
const statusOnly = args.includes('--status');

const system = (workspaceId) => ({
  id: '00000000-0000-0000-0000-000000000000',
  role: 'system',
  org_id: null,
  workspace_id: workspaceId,
});

async function workspaces() {
  const { rows } = await query(`SELECT workspace_id FROM auth.active_workspaces()`);
  const out = [];
  for (const { workspace_id: id } of rows) {
    const { rows: w } = await withSession(system(id), (c) =>
      c.query(`SELECT id, slug, name FROM workspaces WHERE id = $1`, [id]),
    );
    if (w[0]) out.push(w[0]);
  }
  return out;
}

async function main() {
  if (!statusOnly && !all && !(args.includes('--workspace') && slugArg)) {
    console.error('Usage: qlix-provision.mjs --workspace <slug> | --all | --status');
    process.exit(2);
  }
  const list = await workspaces();
  const targets = statusOnly || all ? list : list.filter((w) => w.slug === slugArg);
  if (!targets.length) {
    console.error(`No active workspace${slugArg ? ` with slug "${slugArg}"` : ''}.`);
    process.exit(1);
  }

  if (!statusOnly && !qlixConfigured()) {
    console.error('Set QLIX_BACKEND_URL and QLIX_PARTNER_KEY first.');
    process.exit(1);
  }

  let failed = 0;
  for (const w of targets) {
    if (!statusOnly) {
      try {
        await provisionWorkspace(w.id);
      } catch (e) {
        failed += 1;
        console.error(`✗ ${w.slug}: ${e.message}`);
      }
    }
    const s = await withSession(system(w.id), (c) => qlixStatus(c));
    const agents = s.agents.map((a) => `${a.name}=${a.id ?? '—'}`).join(', ');
    console.log(`${w.slug.padEnd(16)} ${s.status.padEnd(11)} org=${s.org_id ?? '—'} ${agents}${s.last_error ? ` error="${s.last_error}"` : ''}`);
  }
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
