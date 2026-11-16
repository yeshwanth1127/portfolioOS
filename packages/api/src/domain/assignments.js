import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { dbQuery } from './db-helpers.js';

const ASSIGNMENT_ROLES = new Set(['unit_manager', 'unit_deputy', 'team_lead', 'contributor']);

async function loadUnit(client, unitId) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, parent_id, type, name, legacy_org_id, workspace_id
     FROM units WHERE id = $1`,
    [unitId],
  );
  return rows[0] ?? null;
}

async function legacyOrgIdForUnit(client, unit) {
  let current = unit;
  const seen = new Set();
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    if (current.type === 'organisation' && current.legacy_org_id) {
      return current.legacy_org_id;
    }
    if (!current.parent_id) return null;
    current = await loadUnit(client, current.parent_id);
  }
  return null;
}

async function loadOrgForUnit(client, unit) {
  const orgId = await legacyOrgIdForUnit(client, unit);
  if (!orgId) return null;
  const { rows } = await dbQuery(client, `SELECT id, slug FROM organisations WHERE id = $1`, [orgId]);
  return rows[0] ?? null;
}

/**
 * Add a secondary assignment (is_primary must be false).
 * Writes assignments only — no legacy memberships row (primary path stays on people APIs).
 */
export async function createAssignment(client, membership, body) {
  const {
    user_id: userId,
    unit_id: unitId,
    role,
    title,
    reports_to: reportsTo,
    is_primary: isPrimary,
  } = body ?? {};

  if (isPrimary === true) {
    return {
      error: {
        code: 'invalid',
        message: 'Primary assignments use POST /orgs/:slug/people (membership dual-write).',
      },
    };
  }
  if (isPrimary !== false && isPrimary !== undefined) {
    return { error: { code: 'invalid', message: 'is_primary must be false for secondary assignments.' } };
  }
  if (!userId || !unitId || !role) {
    return { error: { code: 'invalid', message: 'user_id, unit_id, and role are required.' } };
  }
  const safeRole = String(role).trim();
  if (!ASSIGNMENT_ROLES.has(safeRole)) {
    return { error: { code: 'invalid', message: 'role must be a valid assignment role.' } };
  }

  const unit = await loadUnit(client, unitId);
  if (!unit || unit.workspace_id !== membership.workspace_id) {
    return { error: { code: 'not_found', message: 'Unit not found.' } };
  }
  const org = await loadOrgForUnit(client, unit);
  if (!org) return { error: { code: 'invalid', message: 'Unit is not under an organisation.' } };
  if (!can(membership, 'person.manage', { org })) {
    return permissionDenied(membership, 'person.manage', 'Only the manager or owner can add an assignment here.');
  }

  const { rows: members } = await dbQuery(
    client,
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [membership.workspace_id, userId],
  );
  if (!members[0]) {
    return { error: { code: 'invalid', message: 'User is not in this workspace.' } };
  }

  if (reportsTo) {
    const { rows: reports } = await dbQuery(
      client,
      `SELECT id FROM assignments WHERE id = $1 AND workspace_id = $2 AND status = 'active'`,
      [reportsTo, membership.workspace_id],
    );
    if (!reports[0]) {
      return { error: { code: 'invalid', message: 'reports_to must be an active assignment in this workspace.' } };
    }
  }

  const { rows: beforeMemberships } = await dbQuery(
    client,
    `SELECT count(*)::int AS c FROM memberships WHERE user_id = $1 AND workspace_id = $2 AND state = 'active'`,
    [userId, membership.workspace_id],
  );
  const membershipCountBefore = beforeMemberships[0].c;

  try {
    const { rows } = await dbQuery(
      client,
      `INSERT INTO assignments (
         workspace_id, user_id, unit_id, role, title, reports_to, is_primary, status
       ) VALUES ($1,$2,$3,$4,$5,$6,false,'active')
       RETURNING id, workspace_id, user_id, unit_id, role, title, reports_to, is_primary, status`,
      [
        membership.workspace_id,
        userId,
        unitId,
        safeRole,
        title?.trim() || safeRole.replace(/_/g, ' '),
        reportsTo || null,
      ],
    );
    const { rows: afterMemberships } = await dbQuery(
      client,
      `SELECT count(*)::int AS c FROM memberships WHERE user_id = $1 AND workspace_id = $2 AND state = 'active'`,
      [userId, membership.workspace_id],
    );
    return {
      assignment: rows[0],
      ok: true,
      memberships_unchanged: afterMemberships[0].c === membershipCountBefore,
    };
  } catch (err) {
    if (err?.code === '23505' && String(err.message).includes('one_primary_assignment')) {
      return { error: { code: 'invalid', message: 'User already has a primary assignment in this workspace.' } };
    }
    if (err?.code === '23505' && String(err.message).includes('one_unit_manager_per_org')) {
      return { error: { code: 'invalid', message: 'This unit already has a unit manager.' } };
    }
    throw err;
  }
}
