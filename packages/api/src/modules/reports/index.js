/*
 * Reports section (docs/REPORTS.md).
 *
 *   1. createReport      validate type + scope + dates, insert a queued row (caller's transaction)
 *   2. runReport         detached: compute datasets in the requester's scope, lay out the report,
 *                        write a plain summary, then ask the Qlix agent for the narrative
 *   3. the agent         calls `report_data` (this report's figures) and replies with text; any
 *                        line quoting a number that is not in the datasets is dropped
 *   4. ready             page view, CSV / XLSX download, print-to-PDF page, submit to manager
 *
 * Database transactions are never held across the agent call.
 */
import { loadMembership } from '../../auth.js';
import { config } from '../../core/config.js';
import { addDays, isIsoDate, todayIn } from '../../core/dates.js';
import { withSession } from '../../db.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { agentMessage, compactForAgent, parseAgentReply, verifyNarrative } from './narrative.js';
import { defaultKind, resolveScope, scopeOptions } from './scope.js';
import { TYPE_BY_ID, buildLayout, templateSummary, typesFor } from './types.js';
import { reportToCsv, reportToXlsx } from './xlsx.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });
const MAX_DAYS = 366;
const STALE_MINUTES = 10;
const AGENT_TIMEOUT_MS = Number(process.env.REPORTS_AGENT_TIMEOUT_MS ?? 120000);
const REPORT_AGENT_ID = 'portfolio-report-agent';

const LIST_COLUMNS = `r.id, r.report_type, r.title, r.scope_kind, r.scope_label, r.period_from, r.period_to,
  r.status, r.narrative_source, r.channel, r.created_at, r.completed_at, r.submitted_at,
  r.requested_by, r.submitted_to, u.full_name AS requested_by_name`;

function tz(membership) {
  return membership.workspace_timezone ?? 'Asia/Kolkata';
}

/** Types, scopes and people this caller can pick from. */
export async function reportOptions(client, membership) {
  const { scopes, people } = await scopeOptions(client, membership);
  return {
    types: typesFor(membership.role).map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      icon: t.icon,
      personal: Boolean(t.personal),
    })),
    scopes,
    people,
    default_scope: defaultKind(membership),
    today: todayIn(tz(membership)),
    role: membership.role,
  };
}

/** Insert a queued report. Run it with runReport() after the transaction commits. */
export async function createReport(client, membership, body = {}, { channel = 'web' } = {}) {
  const type = TYPE_BY_ID.get(String(body.report_type ?? body.type ?? ''));
  if (!type) return err('invalid', 'Choose a report type.');
  if (!type.roles.includes(membership.role)) return err('forbidden', 'This report is not available for your role.');

  const today = todayIn(tz(membership));
  const from = isIsoDate(body.from) ? String(body.from) : today;
  const to = isIsoDate(body.to) ? String(body.to) : from;
  if (from > to) return err('invalid', 'The start date must be on or before the end date.');
  if (addDays(from, MAX_DAYS) <= to) return err('invalid', 'Reports cover at most one year.');
  if (from > today) return err('invalid', 'The period has not started yet.');

  const input = { scope_kind: body.scope_kind, scope_ref: body.scope_ref };
  if (type.personal && !input.scope_kind) input.scope_kind = 'me';
  const scope = await resolveScope(client, membership, input);
  if (scope.error) return scope;

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim().slice(0, 1000) || null : null;
  const title = `${type.label} · ${scope.label}`;
  const { rows } = await client.query(
    `INSERT INTO generated_reports
       (requested_by, report_type, title, scope_kind, scope_ref, scope_label, period_from, period_to, instructions, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, report_type, title, scope_kind, scope_label, period_from, period_to, status, created_at`,
    [membership.id, type.id, title, scope.kind, scope.ref, scope.label, from, to, instructions, channel],
  );
  return { report: rows[0] };
}

async function loadReportRow(client, id) {
  if (!UUID.test(String(id ?? ''))) return null;
  const { rows } = await client.query(
    `SELECT r.*, u.full_name AS requested_by_name, su.full_name AS submitted_to_name
     FROM generated_reports r
     JOIN memberships m ON m.id = r.requested_by
     JOIN users u ON u.id = m.user_id
     LEFT JOIN memberships sm ON sm.id = r.submitted_to
     LEFT JOIN users su ON su.id = sm.user_id
     WHERE r.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Compute datasets + layout + plain summary. Runs in the requester's scope. */
async function computeReport(client, membership, row) {
  const type = TYPE_BY_ID.get(row.report_type);
  const scope = await resolveScope(client, membership, { scope_kind: row.scope_kind, scope_ref: row.scope_ref });
  if (scope.error) throw new Error(scope.error.message);
  const ctx = {
    client,
    from: row.period_from,
    to: row.period_to,
    tz: tz(membership),
    today: todayIn(tz(membership)),
    scope,
  };
  const datasets = await type.build(ctx);
  const sections = buildLayout(type, datasets, ctx);
  const summary = templateSummary(type, datasets);
  return {
    datasets,
    spec: {
      sections,
      summary,
      template_summary: summary,
      highlights: [],
      watch: [],
      people_in_scope: scope.people.length,
      generated_at: new Date().toISOString(),
    },
  };
}

/**
 * Ask the workspace's Qlix "Report writer" agent (via the agent runner) for the narrative.
 * Always returns an object: { reply, usedData } on success, or { unavailable: '<why>' } so the
 * report can say the summary came from the template and the log names the cause.
 */
async function askAgent(membership, row) {
  const url = process.env.REPORTS_RUNNER_URL ?? config.runnerUrl;
  if (!url || process.env.REPORTS_AGENT === 'off') return { unavailable: 'agent switched off' };
  if (process.env.NODE_ENV === 'test' && !process.env.REPORTS_RUNNER_URL) return { unavailable: 'test mode' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-service-secret': config.runnerSecret },
      body: JSON.stringify({
        membership_id: membership.id,
        agent_id: REPORT_AGENT_ID,
        message: agentMessage(row),
        history: [],
        channel: 'report',
        profile: 'report',
        report_id: row.id,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { unavailable: data.code ?? data.error ?? `runner returned ${res.status}` };
    if (typeof data.reply !== 'string') return { unavailable: 'no reply from the agent' };
    const usedData = (data.tools ?? []).some((t) => t?.action === 'report_data');
    if (!usedData) return { unavailable: 'agent did not read the report data', reply: data.reply };
    return { reply: data.reply, usedData, qlixRunId: data.qlix_run_id ?? null };
  } catch (e) {
    return { unavailable: e?.name === 'AbortError' ? 'agent timed out' : `runner unreachable (${e?.message ?? e})` };
  } finally {
    clearTimeout(timer);
  }
}

const running = new Set();

/**
 * Generate a queued report. Safe to call without awaiting (errors are recorded on the row).
 * @param {string} reportId
 * @param {string} membershipId requester
 */
export async function runReport(reportId, membershipId) {
  if (running.has(reportId)) return;
  running.add(reportId);
  try {
    const membership = await loadMembership(membershipId);
    if (!membership) return;

    // 1. Figures and layout (short transaction).
    const prepared = await withSession(membership, async (client) => {
      const row = await loadReportRow(client, reportId);
      if (!row || row.requested_by !== membership.id || row.status === 'ready') return null;
      await client.query(`UPDATE generated_reports SET status = 'running', started_at = now(), error = NULL WHERE id = $1`, [reportId]);
      try {
        const out = await computeReport(client, membership, row);
        await client.query(
          `UPDATE generated_reports SET datasets = $2::jsonb, spec = $3::jsonb, narrative_source = 'template' WHERE id = $1`,
          [reportId, JSON.stringify(out.datasets), JSON.stringify(out.spec)],
        );
        return { row: { ...row, ...out } };
      } catch (e) {
        await client.query(
          `UPDATE generated_reports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
          [reportId, String(e.message ?? e).slice(0, 500)],
        );
        return null;
      }
    });
    if (!prepared) return;

    // 2. Narrative from the Qlix agent (no transaction held).
    const agent = await askAgent(membership, prepared.row);
    let spec = prepared.row.spec;
    let source = 'template';
    let note = null;
    if (agent.reply && agent.usedData) {
      const verified = verifyNarrative(parseAgentReply(agent.reply), prepared.row);
      if (verified.summary) {
        spec = { ...spec, summary: verified.summary, highlights: verified.highlights, watch: verified.watch };
        source = 'agent';
        if (agent.qlixRunId) spec = { ...spec, qlix_run_id: agent.qlixRunId };
        if (verified.dropped) note = `${verified.dropped} line(s) of the agent's draft were removed because they quoted numbers not in the data.`;
      } else {
        agent.unavailable = 'agent draft had no usable summary';
      }
    }
    if (source === 'template') {
      // Say so on the report, and in the log, instead of silently using the template.
      spec = { ...spec, agent_unavailable: true };
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[reports] ${reportId}: summary from template; agent unavailable: ${agent.unavailable ?? 'unknown'}`);
      }
    }
    if (note) spec = { ...spec, narrative_note: note };

    // 3. Ready.
    await withSession(membership, async (client) => {
      await client.query(
        `UPDATE generated_reports SET spec = $2::jsonb, narrative_source = $3, status = 'ready', completed_at = now()
         WHERE id = $1`,
        [reportId, JSON.stringify(spec), source],
      );
      if (prepared.row.channel === 'whatsapp' && membership.phone_e164) {
        const link = process.env.PORTFOLIO_WEB_URL ? `\n${process.env.PORTFOLIO_WEB_URL.replace(/\/$/, '')}/reports/${reportId}` : '';
        const body = `${prepared.row.title}\n${prepared.row.period_from} to ${prepared.row.period_to}\n\n${spec.summary}${link}`;
        await client.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1, $2, 'report')`, [
          membership.phone_e164,
          body.slice(0, 3500),
        ]);
      }
    });
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('[reports] run failed', reportId, e.message);
    const membership = await loadMembership(membershipId).catch(() => null);
    if (membership) {
      await withSession(membership, (client) =>
        client.query(
          `UPDATE generated_reports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1 AND status <> 'ready'`,
          [reportId, String(e.message ?? e).slice(0, 500)],
        ),
      ).catch(() => {});
    }
  } finally {
    running.delete(reportId);
  }
}

export async function listReports(client, membership) {
  await client.query(
    `UPDATE generated_reports SET status = 'failed', error = 'Generation was interrupted. Try again.', completed_at = now()
     WHERE requested_by = $1 AND status IN ('queued','running') AND created_at < now() - ($2 || ' minutes')::interval`,
    [membership.id, String(STALE_MINUTES)],
  );
  const { rows: mine } = await client.query(
    `SELECT ${LIST_COLUMNS} FROM generated_reports r
     JOIN memberships m ON m.id = r.requested_by JOIN users u ON u.id = m.user_id
     WHERE r.requested_by = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [membership.id],
  );
  const { rows: shared } = await client.query(
    `SELECT ${LIST_COLUMNS} FROM generated_reports r
     JOIN memberships m ON m.id = r.requested_by JOIN users u ON u.id = m.user_id
     WHERE r.submitted_to = $1 ORDER BY r.submitted_at DESC LIMIT 100`,
    [membership.id],
  );
  return { mine, shared };
}

export async function getReport(client, membership, id) {
  const row = await loadReportRow(client, id);
  if (!row) return err('not_found', 'Report not found.');
  return {
    report: {
      ...row,
      can_submit: row.requested_by === membership.id && membership.role !== 'owner' && row.status === 'ready',
      is_mine: row.requested_by === membership.id,
    },
  };
}

/** Send a ready report to the person you report to (or the owner, if you report to no one). */
export async function submitReport(client, membership, id) {
  const row = await loadReportRow(client, id);
  if (!row) return err('not_found', 'Report not found.');
  if (row.requested_by !== membership.id) return err('forbidden', 'Only the person who made this report can submit it.');
  if (row.status !== 'ready') return err('conflict', 'The report is not ready yet.');
  if (membership.role === 'owner') return err('invalid', 'The owner has no one to submit to.');
  let to = membership.parent_id;
  if (!to) {
    const { rows } = await client.query(
      `SELECT id FROM memberships WHERE role = 'owner' AND state <> 'inactive' ORDER BY created_at LIMIT 1`,
    );
    to = rows[0]?.id ?? null;
  }
  if (!to) return err('invalid', 'There is no one to submit this report to.');
  await client.query(`UPDATE generated_reports SET submitted_to = $2, submitted_at = now() WHERE id = $1`, [id, to]);
  await enqueue(client, 'report_notify', {
    membership_id: to,
    body: `${membership.full_name ?? 'A team member'} sent you a report: ${row.title} (${row.period_from} to ${row.period_to}).`.slice(0, 480),
  });
  return { ok: true, submitted_to: to };
}

export async function deleteReport(client, membership, id) {
  const row = await loadReportRow(client, id);
  if (!row) return err('not_found', 'Report not found.');
  if (row.requested_by !== membership.id) return err('forbidden', 'Only the person who made this report can delete it.');
  await client.query(`DELETE FROM generated_reports WHERE id = $1`, [id]);
  return { ok: true };
}

/** Re-run a failed report (same type, scope and period). */
export async function retryReport(client, membership, id) {
  const row = await loadReportRow(client, id);
  if (!row) return err('not_found', 'Report not found.');
  if (row.requested_by !== membership.id) return err('forbidden', 'Only the person who made this report can retry it.');
  if (row.status === 'ready' || row.status === 'running') return err('conflict', 'This report does not need a retry.');
  await client.query(
    `UPDATE generated_reports SET status = 'queued', error = NULL, created_at = now(), completed_at = NULL WHERE id = $1`,
    [id],
  );
  return { report: { id } };
}

export async function exportReport(client, membership, id, format) {
  const out = await getReport(client, membership, id);
  if (out.error) return out;
  const r = out.report;
  if (r.status !== 'ready') return err('conflict', 'The report is not ready yet.');
  const flat = { ...r, summary: r.spec?.summary ?? '' };
  const base = `${r.title} ${r.period_from}${r.period_to !== r.period_from ? `_${r.period_to}` : ''}`
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  if (format === 'xlsx') {
    return {
      filename: `${base}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: reportToXlsx(flat),
    };
  }
  return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: reportToCsv(flat) };
}

/** `report_data` agent tool: this run's report, compacted. Only on report-profile run tokens. */
export async function reportDataForAgent(client, membership, run) {
  if (run?.profile !== 'report' || !UUID.test(String(run?.report_id ?? ''))) {
    return err('forbidden', 'report_data is only available while drafting a report.');
  }
  const row = await loadReportRow(client, run.report_id);
  if (!row || row.requested_by !== membership.id) return err('not_found', 'Report not found.');
  return compactForAgent(row);
}

/** Queue generation from inside a transaction (agent / WhatsApp path); runs after commit. */
export async function queueReportRun(client, reportId, membershipId) {
  await enqueue(client, 'report_generate', { report_id: reportId, membership_id: membershipId }, { dedupeKey: `report:${reportId}` });
}

registerJob('report_generate', async (_client, payload) => {
  // Detached: generation opens its own scoped transactions as the requester.
  setImmediate(() => runReport(payload.report_id, payload.membership_id));
});

registerJob('report_notify', async (client, payload) => {
  await client.query(`INSERT INTO notifications (membership_id, kind, body, channel) VALUES ($1, 'report', $2, 'in_app')`, [
    payload.membership_id,
    payload.body,
  ]);
});
