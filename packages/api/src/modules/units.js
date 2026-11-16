import { isOwner } from '../roles.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { dbQuery } from '../domain/db-helpers.js';

const CHILD_TYPES = new Set(['branch', 'department', 'team']);

/**
 * Typed unit tree for the current workspace (RLS-scoped).
 * Owner: full tree. Managers: units linked to their organisation only in this slice.
 */
export async function listUnitTree(client, membership) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, parent_id, type, name, short_name, status, legacy_org_id
     FROM units
     ORDER BY lower(name), created_at`,
  );

  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, { ...row, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else if (!node.parent_id) {
      roots.push(node);
    }
  }

  let scope = membership.role === 'owner' ? 'workspace' : 'organisation';
  if (scope === 'organisation') {
    const { rows } = await dbQuery(
      client,
      `SELECT count(*)::int AS c
       FROM assignments a
       JOIN memberships m ON m.user_id = a.user_id AND m.id = $1
       WHERE a.workspace_id = $2 AND a.status = 'active' AND NOT a.is_primary`,
      [membership.id, membership.workspace_id],
    );
    if (rows[0].c > 0) scope = 'assignments';
  }
  return { tree: roots, scope };
}

async function loadUnit(client, unitId) {
  const { rows } = await dbQuery(
    client,
    `SELECT id, parent_id, type, name, short_name, status, legacy_org_id
     FROM units WHERE id = $1`,
    [unitId],
  );
  return rows[0] ?? null;
}

/** Walk up to the organisation root and return its legacy_org_id (organisations.id). */
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

async function loadOrgById(client, orgId) {
  const { rows } = await dbQuery(client, `SELECT id, slug, name FROM organisations WHERE id = $1`, [orgId]);
  return rows[0] ?? null;
}

async function assertCanManageUnit(client, membership, unit, { opaque = false } = {}) {
  if (!unit) {
    if (opaque) return { error: { code: 'forbidden', message: 'Forbidden' } };
    return { error: { code: 'not_found', message: 'Unit not found' } };
  }
  const orgId = await legacyOrgIdForUnit(client, unit);
  if (!orgId) return { error: { code: 'invalid', message: 'Unit is not under an organisation.' } };
  const org = await loadOrgById(client, orgId);
  if (!org) return { error: { code: 'not_found', message: 'Organisation not found' } };
  if (!can(membership, 'unit.manage', { org })) {
    return permissionDenied(membership, 'unit.manage');
  }
  return { org };
}

function pgErrorMessage(err) {
  const msg = err?.message ?? '';
  if (err?.code === '23505' && msg.includes('units_sibling_name')) {
    return { error: { code: 'conflict', message: 'Another unit with this name already exists here.' } };
  }
  if (msg.includes('must be under')) {
    return { error: { code: 'invalid', message: msg } };
  }
  throw err;
}

export async function createUnit(client, membership, body) {
  const { parent_id: parentId, type, name, short_name: shortName } = body ?? {};
  if (!parentId) return { error: { code: 'invalid', message: 'parent_id is required.' } };
  if (!name || !String(name).trim()) return { error: { code: 'invalid', message: 'name is required.' } };
  const unitType = String(type ?? '').trim();
  if (!CHILD_TYPES.has(unitType)) {
    return { error: { code: 'invalid', message: 'type must be branch, department, or team.' } };
  }

  const parent = await loadUnit(client, parentId);
  const gate = await assertCanManageUnit(client, membership, parent, { opaque: true });
  if (gate.error) return gate;

  try {
    const { rows } = await dbQuery(
      client,
      `INSERT INTO units (parent_id, type, name, short_name, workspace_id)
       VALUES ($1, $2::unit_type, $3, $4, $5)
       RETURNING id, parent_id, type, name, short_name, status, legacy_org_id`,
      [parentId, unitType, String(name).trim(), shortName?.trim() || null, membership.workspace_id],
    );
    return { unit: rows[0], ok: true };
  } catch (err) {
    return pgErrorMessage(err);
  }
}

export async function updateUnit(client, membership, unitId, body) {
  const unit = await loadUnit(client, unitId);
  const gate = await assertCanManageUnit(client, membership, unit, { opaque: !isOwner(membership) });
  if (gate.error) return gate;

  const { name, short_name: shortName, status } = body ?? {};
  if (name === undefined && shortName === undefined && status === undefined) {
    return { error: { code: 'invalid', message: 'Nothing to update.' } };
  }

  try {
    const { rows } = await dbQuery(
      client,
      `UPDATE units
       SET name = COALESCE($2, name),
           short_name = COALESCE($3, short_name),
           status = COALESCE($4, status)
       WHERE id = $1
       RETURNING id, parent_id, type, name, short_name, status, legacy_org_id`,
      [
        unitId,
        name !== undefined ? String(name).trim() : null,
        shortName !== undefined ? (shortName === null ? null : String(shortName).trim() || null) : null,
        status ?? null,
      ],
    );
    return { unit: rows[0] };
  } catch (err) {
    return pgErrorMessage(err);
  }
}
