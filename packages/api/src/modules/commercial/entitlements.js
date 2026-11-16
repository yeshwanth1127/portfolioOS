import { isOwner } from '../../roles.js';

export async function listPlans(client) {
  const { rows } = await client.query(`SELECT code, name, features FROM plans ORDER BY code`);
  return { plans: rows };
}

export async function provisionEntitlement(client, membership, workspaceId, body, { admin = false } = {}) {
  if (!admin) {
    if (membership.workspace_id !== workspaceId) {
      return { error: { code: 'forbidden', message: 'Not allowed to change entitlements for that workspace.' } };
    }
    if (!isOwner(membership)) {
      return { error: { code: 'forbidden', message: 'Only the workspace owner can change the plan.' } };
    }
  }
  const planCode = String(body?.plan_code ?? '').trim();
  if (!planCode) return { error: { code: 'invalid', message: 'plan_code required' } };
  await client.query(`SELECT auth.set_workspace_entitlement($1, $2, $3, $4::jsonb)`, [
    workspaceId,
    planCode,
    body?.expires_at ?? null,
    JSON.stringify(body?.metadata ?? {}),
  ]);
  const { rows } = await client.query(
    `SELECT p.code, p.name, p.features, we.granted_at, we.expires_at, we.metadata
     FROM workspace_entitlements we JOIN plans p ON p.id = we.plan_id
     WHERE we.workspace_id = $1`,
    [workspaceId],
  );
  return { entitlement: rows[0] ?? null };
}

export async function currentEntitlement(client, membership) {
  const { rows } = await client.query(
    `SELECT p.code, p.name, p.features, we.granted_at, we.expires_at, we.metadata
     FROM workspace_entitlements we JOIN plans p ON p.id = we.plan_id
     WHERE we.workspace_id = $1`,
    [membership.workspace_id],
  );
  return { entitlement: rows[0] ?? null };
}
