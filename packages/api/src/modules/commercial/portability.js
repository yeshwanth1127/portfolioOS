import fs from 'fs';
import os from 'os';
import path from 'path';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { disableWorkspaceQlix } from '../qlix/provision.js';
import { isOwner } from '../../roles.js';

const EXPORT_ROOT = process.env.WORKSPACE_EXPORT_DIR ?? path.join(os.tmpdir(), 'portfolio-exports');

export async function enqueueExport(client, membership) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Export is for the workspace owner.' } };
  }
  const { rows } = await client.query(
    `INSERT INTO workspace_export_jobs (status) VALUES ('queued') RETURNING id, status, created_at`,
  );
  const job = rows[0];
  await enqueue(client, 'workspace_export', { export_job_id: job.id }, { dedupeKey: `export:${job.id}` });
  if (process.env.NODE_ENV === 'test') {
    await runWorkspaceExport(client, membership.workspace_id, job.id);
  }
  return { export_job: job };
}

export async function runWorkspaceExport(client, workspaceId, exportJobId) {
  await client.query(`UPDATE workspace_export_jobs SET status = 'running' WHERE id = $1`, [exportJobId]);

  const dir = path.join(EXPORT_ROOT, workspaceId, exportJobId);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { workspace_id: workspaceId, exported_at: new Date().toISOString(), files: [] };

  const { rows: people } = await client.query(
    `SELECT m.id, u.full_name, u.email, m.role, m.title, o.slug AS org_slug
     FROM memberships m JOIN users u ON u.id = m.user_id
     LEFT JOIN organisations o ON o.id = m.org_id
     WHERE m.state <> 'inactive' ORDER BY u.full_name`,
  );
  const peopleCsv = [
    'membership_id,full_name,email,role,title,org_slug',
    ...people.map((r) =>
      [r.id, r.full_name, r.email, r.role, r.title ?? '', r.org_slug ?? ''].map(csvEscape).join(','),
    ),
  ].join('\n');
  const peoplePath = path.join(dir, 'people.csv');
  fs.writeFileSync(peoplePath, peopleCsv);
  manifest.files.push({ name: 'people.csv', rows: people.length });

  const { rows: kpis } = await client.query(
    `SELECT k.code, k.name, k.unit, o.slug AS org_slug FROM kpis k
     JOIN organisations o ON o.id = k.org_id ORDER BY k.code`,
  );
  const kpiCsv = [
    'code,name,unit,org_slug',
    ...kpis.map((r) => [r.code, r.name, r.unit, r.org_slug].map(csvEscape).join(',')),
  ].join('\n');
  const kpiPath = path.join(dir, 'kpis.csv');
  fs.writeFileSync(kpiPath, kpiCsv);
  manifest.files.push({ name: 'kpis.csv', rows: kpis.length });

  const { rows: projects } = await client.query(
    `SELECT p.id, p.name, p.status, u.name AS unit_name FROM projects p
     JOIN units u ON u.id = p.unit_id ORDER BY p.name`,
  );
  const projectCsv = [
    'project_id,name,status,unit_name',
    ...projects.map((r) => [r.id, r.name, r.status, r.unit_name].map(csvEscape).join(',')),
  ].join('\n');
  const projectPath = path.join(dir, 'projects.csv');
  fs.writeFileSync(projectPath, projectCsv);
  manifest.files.push({ name: 'projects.csv', rows: projects.length });

  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  await client.query(
    `UPDATE workspace_export_jobs SET status = 'done', storage_path = $2, manifest = $3::jsonb, completed_at = now()
     WHERE id = $1`,
    [exportJobId, dir, JSON.stringify(manifest)],
  );
  return manifest;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function getExportJob(client, membership, jobId) {
  if (!isOwner(membership)) return { error: { code: 'forbidden', message: 'Export is for the workspace owner.' } };
  const { rows } = await client.query(
    `SELECT id, status, storage_path, manifest, created_at, completed_at, error_message
     FROM workspace_export_jobs WHERE id = $1`,
    [jobId],
  );
  if (!rows[0]) return { error: { code: 'not_found', message: 'Export job not found.' } };
  return { export_job: rows[0] };
}

export async function requestDeletion(client, membership, body) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Deletion requests are for the workspace owner.' } };
  }
  const days = Number(body?.grace_days ?? 7);
  const graceDays = Number.isFinite(days) && days >= 1 && days <= 30 ? days : 7;
  const { rows } = await client.query(
    `INSERT INTO workspace_deletion_requests (workspace_id, requested_by, grace_period_ends_at, status)
     VALUES ($1, $2, now() + ($3::text || ' days')::interval, 'scheduled')
     ON CONFLICT (workspace_id) DO UPDATE SET
       requested_by = EXCLUDED.requested_by,
       requested_at = now(),
       grace_period_ends_at = EXCLUDED.grace_period_ends_at,
       status = 'scheduled'
     RETURNING workspace_id, requested_at, grace_period_ends_at, status`,
    [membership.workspace_id, membership.id, graceDays],
  );
  await enqueue(
    client,
    'workspace_purge',
    { workspace_id: membership.workspace_id },
    { runAt: rows[0].grace_period_ends_at, dedupeKey: `purge:${membership.workspace_id}` },
  );
  return { deletion_request: rows[0] };
}

registerJob('workspace_export', async (client, payload) => {
  const exportJobId = payload?.export_job_id;
  if (!exportJobId) throw new Error('workspace_export requires export_job_id');
  const { rows: meta } = await client.query(`SELECT workspace_id FROM workspace_export_jobs WHERE id = $1`, [
    exportJobId,
  ]);
  const ws = meta[0]?.workspace_id;
  if (!ws) throw new Error('export job missing');
  try {
    await runWorkspaceExport(client, ws, exportJobId);
  } catch (e) {
    await client.query(
      `UPDATE workspace_export_jobs SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1`,
      [exportJobId, e.message?.slice(0, 500) ?? 'export failed'],
    );
    throw e;
  }
});

registerJob('workspace_purge', async (client, payload, job) => {
  const workspaceId = payload?.workspace_id ?? job.workspace_id;
  if (process.env.ALLOW_WORKSPACE_PURGE !== '1') {
    await client.query(
      `UPDATE workspace_deletion_requests SET status = 'scheduled' WHERE workspace_id = $1 AND status = 'scheduled'`,
      [workspaceId],
    );
    return { demo: true, purged: false, workspace_id: workspaceId };
  }
  if (process.env.NODE_ENV === 'test') {
    await client.query(
      `UPDATE workspace_deletion_requests SET status = 'completed' WHERE workspace_id = $1`,
      [workspaceId],
    );
    await client.query(`UPDATE workspaces SET status = 'closed' WHERE id = $1`, [workspaceId]);
    return { demo: true, purged: true, workspace_id: workspaceId };
  }
  await client.query(
    `UPDATE workspace_deletion_requests SET status = 'completed' WHERE workspace_id = $1`,
    [workspaceId],
  );
  await client.query(`UPDATE workspaces SET status = 'closed' WHERE id = $1`, [workspaceId]);
  // A closed workspace's Qlix org stops working too (its agents can no longer run or bill).
  await disableWorkspaceQlix(client, workspaceId);
  return { purged: true, workspace_id: workspaceId };
});
