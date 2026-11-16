import os from 'os';
import { query, withSession } from '../db.js';

/*
 * Durable job queue on Postgres (docs/BUILD.md § 6.5).
 * enqueue() runs inside the caller's scoped transaction, so a job exists only if the change that
 * caused it commits. The worker claims due jobs across workspaces (auth.claim_jobs) and runs each
 * in a 'system' scope for that job's workspace.
 */
const handlers = new Map();
const WORKER_ID = `${os.hostname()}:${process.pid}`;

export function registerJob(kind, handler) {
  handlers.set(kind, handler);
}

/** Queue a job in the current transaction. Same dedupe_key in a workspace = queued once. */
export async function enqueue(client, kind, payload, { runAt = new Date(), dedupeKey = null } = {}) {
  await client.query(`SELECT auth.enqueue_job($1, $2::jsonb, $3, $4)`, [
    kind,
    JSON.stringify(payload ?? {}),
    runAt,
    dedupeKey,
  ]);
}

/** Cancel queued (not yet run) jobs whose dedupe key starts with a prefix — e.g. an event's reminders. */
export async function cancelQueued(client, prefix) {
  await client.query(`SELECT auth.cancel_queued_jobs($1)`, [prefix]);
}

const systemActor = (workspaceId) => ({
  id: '00000000-0000-0000-0000-000000000000',
  role: 'system',
  org_id: null,
  workspace_id: workspaceId,
});

/** Claim and run due jobs once. Returns the number processed. */
export async function runDueJobs(limit = 20) {
  const { rows } = await query(`SELECT * FROM auth.claim_jobs($1, $2)`, [WORKER_ID, limit]);
  for (const job of rows) {
    const handler = handlers.get(job.kind);
    let error = null;
    try {
      if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
      await withSession(systemActor(job.workspace_id), (client) => handler(client, job.payload, job));
    } catch (e) {
      error = String(e.message ?? e).slice(0, 500);
      if (process.env.NODE_ENV !== 'test') console.error(`[jobs] ${job.kind} #${job.id} failed:`, error);
    }
    await query(`SELECT auth.finish_job($1, $2)`, [job.id, error]);
  }
  return rows.length;
}

let timer = null;
export function startWorker(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => runDueJobs().catch((e) => console.error('[jobs] worker', e.message)), intervalMs);
  timer.unref?.();
}
export function stopWorker() {
  clearInterval(timer);
  timer = null;
}
