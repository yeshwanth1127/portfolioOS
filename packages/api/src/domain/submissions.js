import { canReviewSubmissions } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { resolveOrgId } from './org-access.js';
import { findKpi } from './lookup.js';

export async function listSubmissions(client, membership, { org_slug, date }) {
  const period = date ?? new Date().toISOString().slice(0, 10);
  let orgId = membership.org_id;
  if (membership.role === 'owner' && org_slug) {
    orgId = await resolveOrgId(client, membership, org_slug);
  }
  if (!orgId) return { error: { code: 'not_found', message: 'Organisation not in scope' } };
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
  if (kpi.owner_id !== membership.id && membership.role === 'member') {
    return { error: { code: 'forbidden', message: 'Not owner of this KPI' } };
  }
  const period = body.period_date ?? new Date().toISOString().slice(0, 10);
  await dbQuery(
    client,
    `INSERT INTO submissions (org_id, kpi_id, period_date, level, value, state, submitted_by, submitted_at, channel)
     VALUES ($1,$2,$3,$4,$5,'submitted',$6,now(),$7)
     ON CONFLICT (kpi_id, period_date, level) DO UPDATE SET value = EXCLUDED.value, state = 'submitted', submitted_by = EXCLUDED.submitted_by, submitted_at = now(), channel = EXCLUDED.channel`,
    [
      kpi.org_id,
      kpi.id,
      period,
      membership.role,
      body.value,
      membership.id,
      body.channel ?? 'whatsapp',
    ],
  );
  return { ok: true, kpi_code: kpi.code, kpi_name: kpi.name, value: body.value };
}

export async function amendNumber(client, membership, submissionId, value) {
  const { rows } = await dbQuery(client, `SELECT * FROM submissions WHERE id = $1`, [submissionId]);
  const row = rows[0];
  if (!row) return { error: { code: 'not_found', message: 'Not found' } };
  if (membership.role !== 'owner' && row.org_id !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  if (row.state === 'locked') return { error: { code: 'invalid', message: 'This day is locked.' } };
  await dbQuery(client, `UPDATE submissions SET value = $1 WHERE id = $2`, [Number(value), row.id]);
  return { ok: true };
}

export async function withdrawSubmission(client, membership, submissionId) {
  const { rows } = await dbQuery(client, `SELECT * FROM submissions WHERE id = $1`, [submissionId]);
  const row = rows[0];
  if (!row) return { error: { code: 'not_found', message: 'Not found' } };
  if (membership.role !== 'owner' && row.org_id !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  if (row.state === 'locked') return { error: { code: 'invalid', message: 'This day is locked.' } };
  await dbQuery(client, `DELETE FROM submissions WHERE id = $1`, [row.id]);
  return { ok: true };
}

export async function validateSubmission(client, membership, submissionId, body) {
  if (!canReviewSubmissions(membership)) {
    return { error: { code: 'forbidden', message: 'Manager or team lead required' } };
  }
  const { accept, reason } = body ?? {};
  const { rows } = await dbQuery(client, `SELECT id FROM submissions WHERE id = $1`, [submissionId]);
  if (!rows[0]) return { error: { code: 'not_found', message: 'Not found' } };
  await dbQuery(
    client,
    `UPDATE submissions SET state = $1, validated_by = $2, validated_at = now(), reject_reason = $3 WHERE id = $4`,
    [accept ? 'validated' : 'rejected', membership.id, accept ? null : reason, submissionId],
  );
  return { ok: true, accepted: Boolean(accept) };
}
