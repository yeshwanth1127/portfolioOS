import { scoreOrgDay } from '../scoring.js';
import { canLockDay } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { orgIdFromSlug } from './org-access.js';

export async function lockDay(client, membership, orgSlug, periodDate) {
  if (!canLockDay(membership)) {
    return { error: { code: 'forbidden', message: 'Only Thyagu or the manager can lock the day.' } };
  }
  const period = periodDate ?? new Date().toISOString().slice(0, 10);
  const orgId = await orgIdFromSlug(client, orgSlug);
  if (!orgId) return { error: { code: 'not_found', message: 'Not found' } };
  if (membership.role !== 'owner' && orgId !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  await dbQuery(
    client,
    `INSERT INTO signoffs (org_id, period_date, manager_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [orgId, period, membership.id],
  );
  await dbQuery(
    client,
    `UPDATE submissions SET state = 'locked' WHERE org_id = $1 AND period_date = $2 AND state = 'validated'`,
    [orgId, period],
  );
  await scoreOrgDay(client, orgId, period);
  return { ok: true, locked: period };
}
