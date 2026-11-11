import { dbQuery } from './db-helpers.js';
import { resolveOrgId } from './org-access.js';

export async function listScores(client, membership, { org_slug, from, to }) {
  const periodTo = to ?? from;
  if (!from) return { error: { code: 'invalid', message: 'from date is required' } };
  let orgId = membership.org_id;
  if (membership.role === 'owner' && org_slug) {
    orgId = await resolveOrgId(client, membership, org_slug);
  }
  if (!orgId) return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  const { rows } = await dbQuery(
    client,
    `SELECT s.*, k.code FROM scores s JOIN kpis k ON k.id = s.kpi_id
     WHERE s.org_id = $1 AND s.period_date BETWEEN $2 AND $3`,
    [orgId, from, periodTo],
  );
  return { scores: rows };
}
