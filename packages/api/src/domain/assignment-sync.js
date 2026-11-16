import { ROLE, roleLabel } from '../roles.js';
import { dbQuery } from './db-helpers.js';

const LEGACY_TO_ASSIGNMENT = {
  [ROLE.MANAGER]: 'unit_manager',
  [ROLE.VICE_MANAGER]: 'unit_deputy',
  [ROLE.TEAM_LEAD]: 'team_lead',
  [ROLE.MEMBER]: 'contributor',
};

const ASSIGNMENT_TO_LEGACY = {
  unit_manager: ROLE.MANAGER,
  unit_deputy: ROLE.VICE_MANAGER,
  team_lead: ROLE.TEAM_LEAD,
  contributor: ROLE.MEMBER,
};

const ASSIGNMENT_ROLES = new Set(Object.keys(ASSIGNMENT_TO_LEGACY));

export function toAssignmentRole(role) {
  if (ASSIGNMENT_ROLES.has(role)) return role;
  return LEGACY_TO_ASSIGNMENT[role] ?? null;
}

export function toMembershipRole(assignmentRole) {
  return ASSIGNMENT_TO_LEGACY[assignmentRole] ?? ROLE.MEMBER;
}

export async function unitIdForOrg(client, orgId) {
  const { rows } = await dbQuery(client, `SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [orgId]);
  if (rows[0]?.id) return rows[0].id;
  await dbQuery(client, `SELECT auth.sync_units_from_legacy()`);
  const { rows: again } = await dbQuery(client, `SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [orgId]);
  return again[0]?.id ?? null;
}

async function isPrimaryForUser(client, workspaceId, userId, excludeAssignmentId) {
  const { rows } = await dbQuery(
    client,
    `SELECT count(*)::int AS c FROM memberships
     WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner' AND state = 'active'
       AND id IS DISTINCT FROM $3`,
    [workspaceId, userId, excludeAssignmentId],
  );
  return rows[0].c === 0;
}

/** Keep assignments row in sync with a legacy membership (same id when backfilled). */
export async function upsertAssignmentFromMembership(client, membershipRow) {
  const { id, workspace_id, user_id, org_id, role, title, parent_id, state } = membershipRow;
  if (role === ROLE.OWNER) return;
  const unitId = await unitIdForOrg(client, org_id);
  if (!unitId) return;
  const assignmentRole = toAssignmentRole(role);
  if (!assignmentRole) return;
  const isPrimary = await isPrimaryForUser(client, workspace_id, user_id, id);
  const safeTitle = title || roleLabel(role);
  const status = state === 'active' ? 'active' : 'inactive';
  await dbQuery(
    client,
    `INSERT INTO assignments (
       id, workspace_id, user_id, unit_id, role, title, reports_to, is_primary, status, legacy_membership_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$1)
     ON CONFLICT (id) DO UPDATE SET
       unit_id = EXCLUDED.unit_id,
       role = EXCLUDED.role,
       title = EXCLUDED.title,
       reports_to = EXCLUDED.reports_to,
       is_primary = EXCLUDED.is_primary,
       status = EXCLUDED.status`,
    [id, workspace_id, user_id, unitId, assignmentRole, safeTitle, parent_id, isPrimary, status],
  );
}

export async function deactivateAssignment(client, membershipId) {
  await dbQuery(client, `UPDATE assignments SET status = 'inactive' WHERE id = $1`, [membershipId]);
}
