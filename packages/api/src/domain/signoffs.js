import { todayIn } from '../core/dates.js';
import { lockPeriod } from '../core/locks.js';
import { scoreOrgDay } from '../scoring.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { dbQuery } from './db-helpers.js';
import { orgIdFromSlug } from './org-access.js';

const err = (code, message) => ({ error: { code, message } });

async function orgForLock(client, membership, orgSlug, matrixAction = 'day.lock') {
  if (!can(membership, matrixAction)) {
    return permissionDenied(membership, matrixAction);
  }
  const orgId = orgSlug ? await orgIdFromSlug(client, orgSlug) : membership.org_id;
  if (!orgId) return err('not_found', 'Organisation not found');
  if (membership.role !== 'owner' && orgId !== membership.org_id) {
    return err('forbidden', 'That is another organisation.');
  }
  return { orgId };
}

/**
 * Close a day: approved numbers become locked and the day is scored.
 * Numbers still waiting for review stay out of the score and are reported back.
 */
export async function lockDay(client, membership, orgSlug, periodDate) {
  const org = await orgForLock(client, membership, orgSlug);
  if (org.error) return org;
  const period = periodDate ?? todayIn();
  if (period > todayIn()) return err('invalid', 'You cannot close a future day.');

  if ((await lockPeriod(client, org.orgId, period)) === 'locked') {
    return { ok: true, locked: period, already_locked: true };
  }
  await dbQuery(
    client,
    `UPDATE org_periods SET status = 'locked', locked_by = $3, locked_at = now()
     WHERE org_id = $1 AND period_date = $2`,
    [org.orgId, period, membership.id],
  );
  await dbQuery(
    client,
    `INSERT INTO signoffs (org_id, period_date, manager_id) VALUES ($1,$2,$3)
     ON CONFLICT (org_id, period_date) DO UPDATE SET manager_id = EXCLUDED.manager_id, locked_at = now()`,
    [org.orgId, period, membership.id],
  );
  const { rowCount: lockedCount } = await dbQuery(
    client,
    `UPDATE submissions SET state = 'locked' WHERE org_id = $1 AND period_date = $2 AND state = 'validated'`,
    [org.orgId, period],
  );
  const { rows: left } = await dbQuery(
    client,
    `SELECT count(*)::int AS c FROM submissions
     WHERE org_id = $1 AND period_date = $2 AND state IN ('submitted', 'rejected')`,
    [org.orgId, period],
  );
  await scoreOrgDay(client, org.orgId, period);
  return { ok: true, locked: period, numbers_locked: lockedCount, left_unreviewed: left[0].c };
}

/**
 * Reopen a locked day so numbers can be corrected. Audited (who, when, why).
 * Locked numbers go back to approved; the day's scores are removed until it is locked again.
 */
export async function reopenDay(client, membership, orgSlug, periodDate, reason) {
  const org = await orgForLock(client, membership, orgSlug, 'day.reopen');
  if (org.error) return org;
  const why = String(reason ?? '').trim();
  if (!why) return err('invalid', 'Say why the day is being reopened.');
  const period = periodDate ?? todayIn();

  if ((await lockPeriod(client, org.orgId, period)) !== 'locked') {
    return err('invalid', 'That day is not closed.');
  }
  await dbQuery(
    client,
    `UPDATE org_periods SET status = 'open', reopened_by = $3, reopened_at = now(), reopen_reason = $4
     WHERE org_id = $1 AND period_date = $2`,
    [org.orgId, period, membership.id, why],
  );
  await dbQuery(client, `DELETE FROM signoffs WHERE org_id = $1 AND period_date = $2`, [org.orgId, period]);
  const { rowCount } = await dbQuery(
    client,
    `UPDATE submissions SET state = 'validated' WHERE org_id = $1 AND period_date = $2 AND state = 'locked'`,
    [org.orgId, period],
  );
  await dbQuery(client, `DELETE FROM scores WHERE org_id = $1 AND period_date = $2`, [org.orgId, period]);
  return { ok: true, reopened: period, numbers_reopened: rowCount };
}
