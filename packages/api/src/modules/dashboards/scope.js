import { addDays, todayIn } from '../../core/dates.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve dashboard scope for analytics queries (Phase 7).
 * @returns {{ asOf, from, to, tz, kind, orgId, membershipId, unitId, projectId, err? }}
 */
export function parseDashboardQuery(membership, query, { kind = 'workspace', unitId, projectId } = {}) {
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const asOf = typeof query?.date === 'string' && ISO.test(query.date) ? query.date : todayIn(tz);
  const from = typeof query?.from === 'string' && ISO.test(query.from) ? query.from : asOf;
  const to = typeof query?.to === 'string' && ISO.test(query.to) ? query.to : asOf;
  if (from > to) {
    return { err: { code: 'invalid', message: 'from must be on or before to.' } };
  }
  const owner = membership.role === 'owner';
  let orgId = null;
  if (kind === 'me') {
    return {
      asOf,
      from,
      to,
      tz,
      kind: 'me',
      orgId: null,
      membershipId: membership.id,
      unitId: null,
      projectId: null,
    };
  }
  if (kind === 'project') {
    if (!UUID.test(String(projectId ?? ''))) {
      return { err: { code: 'not_found', message: 'Project not found.' } };
    }
    return {
      asOf,
      from,
      to,
      tz,
      kind: 'project',
      orgId: owner ? null : membership.org_id,
      membershipId: null,
      unitId: null,
      projectId,
    };
  }
  if (kind === 'unit') {
    if (!UUID.test(String(unitId ?? ''))) {
      return { err: { code: 'not_found', message: 'Unit not found.' } };
    }
    if (!owner && membership.org_id) {
      orgId = membership.org_id;
    }
    return {
      asOf,
      from,
      to,
      tz,
      kind: 'unit',
      orgId,
      membershipId: null,
      unitId,
      projectId: null,
    };
  }
  if (kind === 'owner' || kind === 'workspace') {
    return {
      asOf,
      from,
      to,
      tz,
      kind: 'workspace',
      orgId: owner ? null : membership.org_id,
      membershipId: null,
      unitId: null,
      projectId: null,
    };
  }
  return { err: { code: 'invalid', message: 'Unknown dashboard scope.' } };
}

function pushScopeParts(scope, parts, params, idx, { meField = 'assignee_id', entityAlias = 't' } = {}) {
  if (scope.kind === 'me') {
    parts.push(`${entityAlias}.${meField} = $${idx}`);
    params.push(scope.membershipId);
    idx += 1;
  } else if (scope.kind === 'project') {
    parts.push(`p.id = $${idx}`);
    params.push(scope.projectId);
    idx += 1;
  } else if (scope.kind === 'unit') {
    parts.push(`p.unit_id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM units WHERE id = $${idx}
        UNION ALL
        SELECT u.id FROM units u JOIN sub ON u.parent_id = sub.id
      )
      SELECT id FROM sub
    )`);
    params.push(scope.unitId);
    idx += 1;
  }
  if (scope.orgId) {
    parts.push(`u.legacy_org_id = $${idx}`);
    params.push(scope.orgId);
    idx += 1;
  }
  return idx;
}

/** SQL fragment for tasks (params start at $startIdx). */
export function deliveryScopeSql(scope, startIdx = 1) {
  const parts = [];
  const params = [];
  const nextIdx = pushScopeParts(scope, parts, params, startIdx, { meField: 'assignee_id', entityAlias: 't' });
  const where = parts.length ? ` AND ${parts.join(' AND ')}` : '';
  return { where, params, nextIdx };
}

export function milestoneScopeSql(scope, startIdx = 1) {
  const parts = [];
  const params = [];
  const nextIdx = pushScopeParts(scope, parts, params, startIdx, { meField: 'owner_id', entityAlias: 'm' });
  const where = parts.length ? ` AND ${parts.join(' AND ')}` : '';
  return { where, params, nextIdx };
}

export function daysInRange(from, to) {
  const out = [];
  let d = from;
  while (d <= to) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
