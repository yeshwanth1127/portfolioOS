import { todayIn } from '../../core/dates.js';
import { isOwner } from '../../roles.js';

export async function noteWaMessage(workspaceId, timezone) {
  return bumpUsage(workspaceId, timezone, 'wa_messages', 1);
}

export async function bumpUsage(workspaceId, timezone, metric, delta = 1) {
  const day = todayIn(timezone ?? 'UTC');
  await import('../../db.js').then(({ query }) =>
    query(`SELECT auth.bump_usage($1, $2::date, $3, $4)`, [workspaceId, day, metric, delta]),
  );
}

export async function noteActiveUser(client, membership) {
  await client.query(`SELECT auth.bump_usage($1, $2::date, 'active_users', 1)`, [
    membership.workspace_id,
    todayIn(membership.workspace_timezone),
  ]);
}

export async function getWorkspaceUsage(client, membership, query) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Usage is visible to the workspace owner only.' } };
  }
  const workspaceId = String(query?.workspace_id ?? membership.workspace_id);
  if (workspaceId !== membership.workspace_id) {
    return { error: { code: 'forbidden', message: 'Cannot read usage for another workspace.' } };
  }
  const from = query?.from ?? null;
  const to = query?.to ?? null;
  const { rows } = await client.query(
    `SELECT day, active_users, agent_tool_calls, wa_messages, updated_at
     FROM workspace_usage_daily
     WHERE workspace_id = $1
       AND ($2::date IS NULL OR day >= $2::date)
       AND ($3::date IS NULL OR day <= $3::date)
     ORDER BY day DESC
     LIMIT 90`,
    [workspaceId, from, to],
  );
  const { rows: totals } = await client.query(
    `SELECT
       coalesce(sum(active_users), 0)::int AS active_users,
       coalesce(sum(agent_tool_calls), 0)::int AS agent_tool_calls,
       coalesce(sum(wa_messages), 0)::int AS wa_messages
     FROM workspace_usage_daily WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { workspace_id: workspaceId, days: rows, totals: totals[0] ?? {} };
}
