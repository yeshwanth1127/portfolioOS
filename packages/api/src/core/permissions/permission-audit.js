/**
 * Phase 4 permission-change audit (`audit_log`, migration 015).
 * Phase 6+ may add structure, target, and ledger kinds on the same table.
 */
export async function notePermissionCheck(client, membership, action, allowed, meta = {}) {
  if (!client || !membership?.id || !membership?.workspace_id || !action) return;
  const kind = allowed ? 'permission.allow' : 'permission.deny';
  const payload = {
    action,
    role: membership.role ?? null,
    ...meta,
  };
  try {
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)`,
      [membership.workspace_id, membership.id, kind, JSON.stringify(payload)],
    );
  } catch {
    // Audit failure must not block the primary request path when no transaction is shared.
  }
}
