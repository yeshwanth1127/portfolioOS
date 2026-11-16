import { todayIn, isIsoDate } from '../core/dates.js';
import { DAY_LOCKED, lockPeriod } from '../core/locks.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { canReviewSubmissions } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { resolveOrgId } from './org-access.js';
import { findKpi } from './lookup.js';

/*
 * Submission states (docs/BUILD.md § 4.5):
 *
 *   record / correct ──► submitted ──approve──► validated ──lock day──► locked
 *                            │  ▲                   │
 *                         reject │ correct          │ correct (needs review again)
 *                            ▼  │                   ▼
 *                         rejected              submitted
 *
 * Every operation takes the organisation-day lock first (core/locks.js). Nothing changes inside
 * a locked day; the owner or manager reopens it (domain/signoffs.js) to allow corrections.
 * Only validated and locked values are scored.
 */

const err = (code, message) => ({ error: { code, message } });

function parseValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reviewer roles may act on any submission in their organisation; others only on their own. */
function mayEdit(membership, row) {
  if (membership.role === 'owner') return true;
  if (row.org_id !== membership.org_id) return false;
  return row.submitted_by === membership.id || canReviewSubmissions(membership);
}

/** Is `targetId` at or below `rootId` in the reporting tree? */
async function reportsInto(client, targetId, rootId) {
  if (!targetId) return false;
  const { rows } = await dbQuery(
    client,
    `WITH RECURSIVE sub AS (
       SELECT id FROM memberships WHERE id = $1
       UNION ALL
       SELECT m.id FROM memberships m JOIN sub ON m.parent_id = sub.id
     )
     SELECT 1 FROM sub WHERE id = $2 LIMIT 1`,
    [rootId, targetId],
  );
  return rows.length > 0;
}

export async function listSubmissions(client, membership, { org_slug, date }) {
  const period = date ?? todayIn();
  let orgId = membership.org_id;
  if (membership.role === 'owner' && org_slug) {
    orgId = await resolveOrgId(client, membership, org_slug);
  }
  if (!orgId) return err('not_found', 'Organisation not in scope');
  const { rows } = await dbQuery(
    client,
    `SELECT s.*, k.code AS kpi_code, k.name AS kpi_name, k.unit AS kpi_unit, k.target AS kpi_goal
     FROM submissions s JOIN kpis k ON k.id = s.kpi_id
     WHERE s.org_id = $1 AND s.period_date = $2
     ORDER BY k.code, s.submitted_at DESC NULLS LAST`,
    [orgId, period],
  );
  return { submissions: rows };
}

export async function recordNumber(client, membership, body) {
  const found = await findKpi(client, membership, body.kpi_code, body.org_slug);
  if (found.error) return found;
  const kpi = found.kpi;
  if (!can(membership, 'submission.record', { kpiOwnerId: kpi.owner_id })) {
    return err('forbidden', 'Not owner of this KPI');
  }
  const value = parseValue(body.value);
  if (value === null) return err('invalid', 'A number is required.');
  if (body.period_date != null && !isIsoDate(body.period_date)) {
    return err('invalid', 'period_date must be YYYY-MM-DD.');
  }
  const period = body.period_date ?? todayIn();
  if (period > todayIn()) return err('invalid', 'You cannot record a number for a future day.');

  if ((await lockPeriod(client, kpi.org_id, period)) === 'locked') return DAY_LOCKED;

  const { rows: existing } = await dbQuery(
    client,
    `SELECT id, value, state FROM submissions
     WHERE kpi_id = $1 AND period_date = $2 AND level = $3 FOR UPDATE`,
    [kpi.id, period, membership.role],
  );
  const prev = existing[0];
  if (prev?.state === 'locked') return DAY_LOCKED;

  const channel = body.channel ?? 'whatsapp';
  let submissionId;
  if (prev) {
    if (prev.value !== null && Number(prev.value) !== value) {
      await dbQuery(
        client,
        `INSERT INTO amendments (submission_id, old_value, new_value, reason, made_by) VALUES ($1,$2,$3,$4,$5)`,
        [prev.id, prev.value, value, String(body.reason ?? '').trim() || 'Number re-entered', membership.id],
      );
    }
    await dbQuery(
      client,
      `UPDATE submissions
       SET value = $2, state = 'submitted', submitted_by = $3, submitted_at = now(), channel = $4,
           validated_by = NULL, validated_at = NULL, reject_reason = NULL
       WHERE id = $1`,
      [prev.id, value, membership.id, channel],
    );
    submissionId = prev.id;
  } else {
    const { rows } = await dbQuery(
      client,
      `INSERT INTO submissions (org_id, kpi_id, period_date, level, value, state, submitted_by, submitted_at, channel)
       VALUES ($1,$2,$3,$4,$5,'submitted',$6,now(),$7) RETURNING id`,
      [kpi.org_id, kpi.id, period, membership.role, value, membership.id, channel],
    );
    submissionId = rows[0].id;
  }
  return {
    ok: true,
    submission_id: submissionId,
    kpi_code: kpi.code,
    kpi_name: kpi.name,
    value,
    period_date: period,
    state: 'submitted',
    corrected: Boolean(prev && prev.value !== null && Number(prev.value) !== value),
  };
}

/** Load a submission, check the caller may touch it, and lock its organisation-day. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function openForChange(client, membership, submissionId) {
  if (!UUID.test(String(submissionId ?? ''))) return err('not_found', 'Submission not found');
  const { rows: peek } = await dbQuery(
    client,
    `SELECT org_id, period_date FROM submissions WHERE id = $1`,
    [submissionId],
  );
  if (!peek[0]) return err('not_found', 'Submission not found');
  if (membership.role !== 'owner' && peek[0].org_id !== membership.org_id) {
    return err('forbidden', 'That submission belongs to another organisation.');
  }
  const status = await lockPeriod(client, peek[0].org_id, peek[0].period_date);
  const { rows } = await dbQuery(client, `SELECT * FROM submissions WHERE id = $1 FOR UPDATE`, [
    submissionId,
  ]);
  if (!rows[0]) return err('not_found', 'Submission not found');
  if (status === 'locked' || rows[0].state === 'locked') return DAY_LOCKED;
  return { row: rows[0] };
}

/** Correct a submitted number. The correction is recorded and goes back for review. */
export async function amendNumber(client, membership, submissionId, rawValue, reason) {
  if (!can(membership, 'submission.amend')) {
    return permissionDenied(membership, 'submission.amend');
  }
  const value = parseValue(rawValue);
  if (value === null) return err('invalid', 'A number is required.');
  const opened = await openForChange(client, membership, submissionId);
  if (opened.error) return opened;
  const { row } = opened;
  if (!mayEdit(membership, row)) {
    return err('forbidden', 'Only the person who submitted it or a reviewer can correct this number.');
  }
  if (row.value !== null && Number(row.value) === value) {
    return { ok: true, unchanged: true, state: row.state };
  }
  if (row.value !== null) {
    await dbQuery(
      client,
      `INSERT INTO amendments (submission_id, old_value, new_value, reason, made_by) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.value, value, String(reason ?? '').trim() || 'Corrected', membership.id],
    );
  }
  await dbQuery(
    client,
    `UPDATE submissions
     SET value = $2, state = 'submitted', validated_by = NULL, validated_at = NULL, reject_reason = NULL
     WHERE id = $1`,
    [row.id, value],
  );
  return {
    ok: true,
    state: 'submitted',
    old_value: row.value === null ? null : Number(row.value),
    value,
    needs_review: true,
  };
}

/** Remove a number that has not been approved. Approved numbers are corrected, not withdrawn. */
export async function withdrawSubmission(client, membership, submissionId) {
  if (!can(membership, 'submission.amend')) {
    return permissionDenied(membership, 'submission.amend');
  }
  const opened = await openForChange(client, membership, submissionId);
  if (opened.error) return opened;
  const { row } = opened;
  if (!mayEdit(membership, row)) {
    return err('forbidden', 'Only the person who submitted it or a reviewer can withdraw this number.');
  }
  if (row.state === 'validated') {
    return err('conflict', 'This number is already approved. Correct it instead of withdrawing it.');
  }
  await dbQuery(client, `DELETE FROM submissions WHERE id = $1`, [row.id]);
  return { ok: true };
}

/** Approve or reject a submitted number. */
export async function validateSubmission(client, membership, submissionId, body) {
  if (!can(membership, 'submission.approve')) {
    return permissionDenied(membership, 'submission.approve');
  }
  const { accept, reason } = body ?? {};
  const opened = await openForChange(client, membership, submissionId);
  if (opened.error) return opened;
  const { row } = opened;

  if (row.state !== 'submitted') {
    const what = row.state === 'validated' ? 'already approved' : row.state === 'rejected' ? 'already rejected' : `in state "${row.state}"`;
    return err('conflict', `This number is ${what}; only a submitted number can be reviewed.`);
  }
  // Nobody reviews their own number, except the people with no reviewer above them in the org.
  if (row.submitted_by === membership.id && !['owner', 'manager'].includes(membership.role)) {
    return err('forbidden', 'You cannot review your own number.');
  }
  // A team lead reviews only the people who report into them.
  if (membership.role === 'team_lead' && !(await reportsInto(client, row.submitted_by, membership.id))) {
    return err('forbidden', 'You can only review numbers from your own team.');
  }
  const rejectReason = String(reason ?? '').trim();
  if (!accept && !rejectReason) return err('invalid', 'Say why you are rejecting this number.');

  await dbQuery(
    client,
    `UPDATE submissions SET state = $1, validated_by = $2, validated_at = now(), reject_reason = $3 WHERE id = $4`,
    [accept ? 'validated' : 'rejected', membership.id, accept ? null : rejectReason, row.id],
  );
  return { ok: true, accepted: Boolean(accept), state: accept ? 'validated' : 'rejected' };
}

/** Correction history for one submission (oldest first). */
export async function listAmendments(client, membership, submissionId) {
  if (!UUID.test(String(submissionId ?? ''))) return err('not_found', 'Submission not found');
  const { rows: sub } = await dbQuery(client, `SELECT org_id FROM submissions WHERE id = $1`, [submissionId]);
  if (!sub[0]) return err('not_found', 'Submission not found');
  if (membership.role !== 'owner' && sub[0].org_id !== membership.org_id) {
    return err('forbidden', 'That submission belongs to another organisation.');
  }
  const { rows } = await dbQuery(
    client,
    `SELECT a.old_value, a.new_value, a.reason, a.made_at, u.full_name AS made_by
     FROM amendments a
     JOIN memberships m ON m.id = a.made_by
     JOIN users u ON u.id = m.user_id
     WHERE a.submission_id = $1 ORDER BY a.made_at`,
    [submissionId],
  );
  return { amendments: rows };
}
