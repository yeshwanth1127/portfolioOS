import { findOrg } from './lookup.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { isOwner } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { loadOrgFor, resolveOrgId } from './org-access.js';

function slugify(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function createOrg(client, membership, body) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Workspace owner only.' } };
  }
  const name = String(body?.name ?? '').trim();
  const shortName = String(body?.short_name ?? body?.shortName ?? name).trim();
  if (!name) return { error: { code: 'invalid', message: 'Name is required.' } };
  if (!shortName) return { error: { code: 'invalid', message: 'Short name is required.' } };
  let slug = String(body?.slug ?? '').trim() || slugify(shortName);
  if (!slug) return { error: { code: 'invalid', message: 'Slug is required.' } };
  slug = slug.slice(0, 48);
  const sector = String(body?.sector ?? 'General').trim() || 'General';
  const descriptor = String(body?.descriptor ?? '').trim() || name;

  try {
    const { rows } = await dbQuery(
      client,
      `INSERT INTO organisations (slug, name, short_name, sector, descriptor)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [slug, name, shortName, sector, descriptor],
    );
    await dbQuery(client, `SELECT auth.sync_units_from_legacy()`);
    return { org: rows[0] };
  } catch (err) {
    if (err?.code === '23505') {
      return { error: { code: 'conflict', message: 'An organisation with this slug already exists.' } };
    }
    throw err;
  }
}

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
  if (!can(membership, 'unit.manage', { org: loaded.org })) {
    return permissionDenied(membership, 'unit.manage');
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
    `SELECT m.id,
            COALESCE(a.id, m.id) AS assignment_id,
            a.unit_id,
            u.full_name,
            m.title,
            m.role,
            m.state,
            u.phone_e164,
            m.parent_id
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN assignments a ON a.id = m.id
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
