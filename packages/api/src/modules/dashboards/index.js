import { isOwner } from '../../roles.js';
import { permissionDenied } from '../../core/permissions/permission-denied.js';
import { parseDashboardQuery } from './scope.js';
import { allMeasures } from './measures.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });

async function loadUnit(client, unitId) {
  const { rows } = await client.query(`SELECT id, legacy_org_id, name, type FROM units WHERE id = $1`, [unitId]);
  return rows[0] ?? null;
}

async function loadProjectRow(client, projectId) {
  const { rows } = await client.query(
    `SELECT p.id, p.name, u.legacy_org_id AS unit_org_id
     FROM projects p JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE p.id = $1`,
    [projectId],
  );
  return rows[0] ?? null;
}

function assertUnitAccess(membership, unit) {
  if (!unit) return err('not_found', 'Unit not found.');
  if (isOwner(membership)) return null;
  if (membership.org_id && unit.legacy_org_id === membership.org_id) return null;
  return permissionDenied(membership, 'project.edit');
}

function assertProjectAccess(membership, project) {
  if (!project) return err('not_found', 'Project not found.');
  if (isOwner(membership)) return null;
  if (
    membership.org_id &&
    project.unit_org_id === membership.org_id &&
    (membership.role === 'manager' || membership.role === 'vice_manager')
  ) {
    return null;
  }
  return null;
}

export async function buildDashboard(client, membership, query, scopeKind, ids = {}) {
  const scope = parseDashboardQuery(membership, query, { kind: scopeKind, ...ids });
  if (scope.err) return scope;

  if (scopeKind === 'owner' && !isOwner(membership)) {
    return permissionDenied(membership, 'kpi.edit');
  }
  if (scopeKind === 'unit') {
    const unit = await loadUnit(client, ids.unitId);
    const denied = assertUnitAccess(membership, unit);
    if (denied) return denied;
  }
  if (scopeKind === 'project') {
    const project = await loadProjectRow(client, ids.projectId);
    const denied = assertProjectAccess(membership, project);
    if (denied) return denied;
  }

  const measures = await allMeasures(client, scope);
  return {
    scope: {
      kind: scope.kind,
      as_of: scope.asOf,
      from: scope.from,
      to: scope.to,
      org_id: scope.orgId,
      unit_id: scope.unitId ?? ids.unitId ?? null,
      project_id: scope.projectId ?? ids.projectId ?? null,
      membership_id: scope.kind === 'me' ? membership.id : null,
    },
    freshness: {
      computed_at: new Date().toISOString(),
      as_of: scope.asOf,
    },
    measures,
  };
}

export async function ownerDashboard(client, membership, query) {
  return buildDashboard(client, membership, query, 'owner');
}

export async function unitDashboard(client, membership, unitId, query) {
  return buildDashboard(client, membership, query, 'unit', { unitId });
}

export async function projectDashboard(client, membership, projectId, query) {
  return buildDashboard(client, membership, query, 'project', { projectId });
}

export async function meDashboard(client, membership, query) {
  return buildDashboard(client, membership, query, 'me');
}

export async function reportsSummary(client, membership, query) {
  const kind = isOwner(membership) ? 'owner' : membership.org_id ? 'workspace' : 'me';
  return buildDashboard(client, membership, query, kind === 'owner' ? 'owner' : kind === 'me' ? 'me' : 'workspace');
}

export function measuresToCsv(payload) {
  const lines = ['measure,as_of,coverage,key,value'];
  if (!payload?.measures) return lines.join('\n');
  for (const [name, block] of Object.entries(payload.measures)) {
    const cov = block.coverage ?? '';
    for (const [k, v] of Object.entries(block.value ?? {})) {
      lines.push(`${name},${block.as_of},${cov},${k},${JSON.stringify(v)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const DRILL_MEASURES = new Set(['task_completion', 'target_attainment', 'on_time_delivery', 'reporting_completeness']);

export async function drillDown(client, membership, query) {
  const measure = String(query?.measure ?? '');
  if (!DRILL_MEASURES.has(measure)) {
    return err('invalid', 'Unknown measure for drill-down.');
  }
  const scopeKind =
    query?.project_id && UUID.test(query.project_id)
      ? 'project'
      : query?.unit_id && UUID.test(query.unit_id)
        ? 'unit'
        : isOwner(membership)
          ? 'owner'
          : 'workspace';
  const dash = await buildDashboard(client, membership, query, scopeKind, {
    unitId: query?.unit_id,
    projectId: query?.project_id,
  });
  if (dash.error) return dash;
  const block = dash.measures[measure];
  if (!block) return err('invalid', 'Measure not available.');
  return { measure, drill_down: block.drill_down, value: block.value, as_of: block.as_of };
}

/** Owner digest snapshot — compact counts for notifications. */
export async function ownerDigestSnapshot(client, workspaceId, timezone) {
  const membership = {
    id: '00000000-0000-0000-0000-000000000000',
    role: 'system',
    org_id: null,
    workspace_id: workspaceId,
    workspace_timezone: timezone,
  };
  const dash = await buildDashboard(client, membership, {}, 'workspace');
  if (dash.error) return dash;
  const m = dash.measures;
  return {
  as_of: dash.freshness.as_of,
  task_completion: m.task_completion.value,
  target_attainment: m.target_attainment.value,
  on_time_delivery: m.on_time_delivery.value,
  reporting_completeness: m.reporting_completeness.value,
  };
}

export function formatDigestBody(snapshot, { period, timezone }) {
  const lines = [`PortfolioOS digest — ${period} (${timezone})`, ''];
  const tc = snapshot.task_completion;
  lines.push(`Tasks: ${tc.done ?? 0} done / ${tc.open ?? 0} open`);
  const ta = snapshot.target_attainment;
  lines.push(`Targets: ${ta.good ?? 0} good · ${ta.watch ?? 0} watch · ${ta.bad ?? 0} bad`);
  const ot = snapshot.on_time_delivery;
  lines.push(`On-time: ${ot.on_time ?? 0} of ${ot.delivered ?? 0} delivered`);
  const rc = snapshot.reporting_completeness;
  lines.push(`Reporting: ${rc.received ?? 0} / ${rc.expected ?? 0} complete`);
  return lines.join('\n');
}
