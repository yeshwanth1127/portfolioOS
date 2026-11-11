import { findOrg } from './lookup.js';
import { managesOrg } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { loadOrgFor, resolveOrgId } from './org-access.js';

export async function listOrgs(client, membership) {
  if (membership.role === 'owner') {
    const { rows } = await dbQuery(client, `SELECT * FROM organisations ORDER BY slug`);
    return { orgs: rows };
  }
  const { rows } = await dbQuery(client, `SELECT * FROM organisations WHERE id = $1`, [
    membership.org_id,
  ]);
  return { orgs: rows };
}

export async function showOrg(client, membership, slug) {
  const org = await findOrg(client, slug);
  if (!org) return { error: { code: 'not_found', message: 'Not found' } };
  if (membership.role !== 'owner' && org.id !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  const { rows: kpiCount } = await dbQuery(
    client,
    `SELECT count(*)::int AS c FROM kpis WHERE org_id = $1`,
    [org.id],
  );
  return { org, kpi_count: kpiCount[0].c };
}

export async function updateOrg(client, membership, slug, body) {
  const loaded = await loadOrgFor(client, membership, slug);
  if (loaded.error) return loaded;
  if (!managesOrg(membership, loaded.org)) {
    return {
      error: { code: 'forbidden', message: 'Only the manager or Thyagu can edit this organisation.' },
    };
  }
  const { name, positioning, descriptor } = body ?? {};
  const { rows } = await dbQuery(
    client,
    `UPDATE organisations
     SET name = COALESCE($2, name),
         positioning = COALESCE($3, positioning),
         descriptor = COALESCE($4, descriptor)
     WHERE id = $1
     RETURNING *`,
    [loaded.org.id, name ?? null, positioning ?? null, descriptor ?? null],
  );
  return { org: rows[0] };
}

export async function listPeopleInOrg(client, membership, slug) {
  const orgId = slug ? await resolveOrgId(client, membership, slug) : membership.org_id;
  if (!orgId) return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  if (membership.role !== 'owner' && orgId !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  const { rows } = await dbQuery(
    client,
    `SELECT m.id, u.full_name, m.title, m.role, m.state, u.phone_e164, m.parent_id
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 AND m.state <> 'inactive'
     ORDER BY CASE m.role
       WHEN 'manager' THEN 0
       WHEN 'vice_manager' THEN 1
       WHEN 'team_lead' THEN 2
       ELSE 3
     END, u.full_name`,
    [orgId],
  );
  return { people: rows };
}
