import { isOwner } from '../../roles.js';

export async function listAuditLog(client, membership, query) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Audit log is for the workspace owner.' } };
  }
  const limit = Math.min(Number(query?.limit ?? 50), 200);
  const offset = Math.max(Number(query?.offset ?? 0), 0);
  const kind = query?.kind ? String(query.kind) : null;
  const { rows } = await client.query(
    `SELECT id, actor_id, kind, payload, at
     FROM audit_log
     WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2)
     ORDER BY at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [membership.workspace_id, kind, limit, offset],
  );
  return { entries: rows, limit, offset };
}
