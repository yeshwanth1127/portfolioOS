import { assertHeadersMatch } from './auth.js';
import { BANDS_NOTE, scoreOrgDay } from './scoring.js';
import { canLockDay, canReviewSubmissions } from './roles.js';
import { showMe, updateMe } from './domain/account.js';
import {
  addKpi,
  assignKpiOwner,
  goalsFor,
  retireKpi,
  setTargetByCode,
  updateKpiRegister,
} from './domain/kpis.js';
import { addPerson, removePerson, updatePerson } from './domain/people.js';
import { resolveOrgId } from './domain/org-access.js';
import { findKpi } from './domain/lookup.js';
import { CADENCE_SHORT } from './cadence.js';
import { listOrgs, listPeopleInOrg, showOrg, updateOrg } from './domain/orgs.js';
import { listScores } from './domain/scores.js';
import { lockDay } from './domain/signoffs.js';
import {
  amendNumber,
  recordNumber,
  validateSubmission,
  withdrawSubmission,
} from './domain/submissions.js';

const RAG_WORDS = { green: 'good', amber: 'watch', red: 'bad', unscored: 'unscored' };

const READ_ACTIONS = new Set([
  'check_readiness',
  'check_day',
  'show_kpi',
  'list_kpis',
  'list_waiting',
  'list_off_track',
  'who_owns',
  'find_person',
  'list_escalations',
  'list_orgs',
  'show_org',
  'list_people',
  'list_scores',
  'list_pending',
  'show_me',
]);

const WRITE_ACTIONS = new Set([
  'record_number',
  'set_target',
  'decide_escalation',
  'add_kpi',
  'update_kpi',
  'assign_kpi_owner',
  'retire_kpi',
  'add_person',
  'update_person',
  'remove_person',
  'amend_number',
  'withdraw_submission',
  'validate_submission',
  'lock_day',
  'update_org',
  'update_me',
]);

export const ACTION_LABELS = {
  check_readiness: 'Check readiness',
  check_day: 'Check the day',
  show_kpi: 'Show KPI',
  list_kpis: 'List KPIs',
  list_waiting: 'Waiting',
  list_off_track: 'Off track',
  who_owns: 'Who owns it',
  find_person: 'Find person',
  list_escalations: 'Escalations',
  list_orgs: 'List organisations',
  show_org: 'Show organisation',
  list_people: 'List people',
  list_scores: 'List scores',
  list_pending: 'Pending numbers',
  show_me: 'My account',
  record_number: 'Record number',
  set_target: 'Set goal',
  decide_escalation: 'Decide',
  add_kpi: 'Add KPI',
  update_kpi: 'Update KPI',
  assign_kpi_owner: 'Assign KPI owner',
  retire_kpi: 'Retire KPI',
  add_person: 'Add person',
  update_person: 'Update person',
  remove_person: 'Remove person',
  amend_number: 'Amend number',
  withdraw_submission: 'Withdraw submission',
  validate_submission: 'Validate submission',
  lock_day: 'Lock day',
  update_org: 'Update organisation',
  update_me: 'Update account',
};

const ACTION_SUMMARIES = {
  check_readiness: 'Counts unnamed people and KPIs missing goals (not a KPI list).',
  check_day: 'Whether the org day is locked plus rag counts for a date.',
  show_kpi: 'One KPI: per-cadence goals (day/week/month/quarter), value to date and good/watch/bad for a date.',
  list_kpis: 'All active KPIs for an org (requires org_slug), each with its tracked cadences and goal per cadence.',
  list_waiting: 'Submissions not locked yet for a date, with submission_id (use it for validate_submission / amend_number / withdraw_submission).',
  list_off_track: 'KPIs in watch or bad for a date (default today; pass date YYYY-MM-DD for another day), per cadence (day/week/month/quarter to date). Only locked days are scored.',
  who_owns: 'Who owns a kpi_code.',
  find_person: 'Search people by name (partial).',
  list_escalations: 'Open escalations.',
  list_orgs: 'Organisations visible to this caller.',
  show_org: 'One org summary and KPI count.',
  list_people: 'Full team roster for an org.',
  list_scores: 'Score rows for a date range (requires from/to).',
  list_pending: 'Owners who have not submitted today.',
  show_me: 'Caller profile, role, and org.',
  record_number: 'Submit a KPI value for a date.',
  set_target: 'Set the goal for one cadence: kpi_code, value, how_often (Every day|Every week|Every month|Every quarter). Adds that cadence if not tracked yet (owner).',
  decide_escalation: 'Close an open escalation (owner).',
  add_kpi: 'Add a measure to the register (owner).',
  update_kpi: 'Change KPI name or unit, rollup_method (sum|average|latest), or replace tracked cadences with goals: [{how_often, target}] (owner).',
  assign_kpi_owner: 'Assign who owns a KPI (owner or manager).',
  retire_kpi: 'Retire a KPI from the active register (owner).',
  add_person: 'Add someone to the org (manager or owner).',
  update_person: 'Edit a person role, title, or reports-to.',
  remove_person: 'Deactivate a person on the roster.',
  amend_number: 'Fix a submitted value before the day is locked.',
  withdraw_submission: 'Delete a submission before lock.',
  validate_submission: 'Accept or reject a submission (manager or team lead).',
  lock_day: 'Validate, lock the day, and compute scores (owner or manager).',
  update_org: 'Edit org name or positioning text.',
  update_me: 'Update caller name or WhatsApp phone.',
};

const PORTFOLIO_PLAYBOOK = `You answer questions about the Sona portfolio. Call portfolio_os with the exact action name. Never invent a number.
Every change (goal, number, KPI, person, lock) must be made by calling the write tool in THIS turn, even if it was discussed earlier. Only say it was done if that call returned ok; otherwise say it was not saved and why.
Colours: good = at or above the goal; watch = from 80% of goal; bad = under 80%.
Org slugs (owner): tms, uatc (Unreal ATC), s3dx (Sonastar3Dx), pats, sai, comms, scale. Dates ISO, timezone Asia/Kolkata, currency INR.
A KPI can be tracked every day, week, month and/or quarter, each with its own goal. Numbers are submitted at the most frequent cadence; week/month/quarter values are rolled up (sums judged on pace to date).
Managers see their org; members usually record only KPIs they own. Use validate_submission then lock_day to close a day.
For a portfolio or org summary, report performance: list_off_track (omit org_slug for the whole portfolio), check_day per org, check_readiness. Do not describe org profiles unless asked.
Dates: pass YYYY-MM-DD or omit (defaults to today).
kpi_code accepts the exact code (comms.creatives) or the KPI name ("creatives delivered"); org_slug accepts the slug or the org name. If a call returns candidates, pick the right code and retry.

Always pass the date the user means (the message carries it as YYYY-MM-DD) to every tool that takes one.

REPLY FORMAT — plain text, shown in the dashboard and sent on WhatsApp. Never use markdown (**, #, backticks, tables) or JSON.
Line 1: short headline that names what was asked plus the date, no full stop (e.g. "Portfolio on 11 Nov", "Off track at PATS, 11 Nov"). Then a blank line.
For a broad "how are we doing" question: one 🔒/⏳ line per organisation (locked first), then the 3 worst KPI lines. Then only these line types:
  🔴 PATS · Drone serviceability — 66.7% of 90%, day      (one KPI; dot = 🔴 bad, 🟡 watch, 🟢 good, ⚪ not scored)
  🔒 TMS — locked · 2 bad, 1 watch, 5 good               (day status; ⏳ TMS — not locked)
  👤 Anju Raj — PATS manager                              (a person)
  ✅ Saved — daily goal for Drone serviceability is now 85%   (only if the write tool returned ok; else "Not saved — <reason>")
  • anything else, one short line
  Next: <one useful follow-up>                            (optional, last line)
Answer only what was asked: "worst 3" is exactly 3 KPI lines (plus an optional Next line) — no extra status, people or commentary lines. Every number must come from a tool result in this turn.
Use the org names and KPI names exactly as the tools return them. Never show codes or ids. Say good/watch/bad, never green/amber/red. Indian number grouping, ₹ for INR, 1 decimal. Max 8 item lines, then "+N more".`;

function todayIst() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** Machine-readable catalogue for agent runtimes (ADK must discover, not hardcode). */
export function getToolCatalog(role = null) {
  const describe = (action, mutating) => {
    const allowed = role == null ? true : actionAllowed(role, action);
    return {
      action,
      label: ACTION_LABELS[action] ?? action,
      summary: ACTION_SUMMARIES[action] ?? ACTION_LABELS[action] ?? action,
      mutating,
      allowed,
    };
  };
  const all = [
    ...[...READ_ACTIONS].map((a) => describe(a, false)),
    ...[...WRITE_ACTIONS].map((a) => describe(a, true)),
  ];
  const tools = role == null ? all : all.filter((t) => t.allowed);
  return {
    capability: 'portfolio_os',
    invoke: 'POST /agent/tools/portfolio_os',
    playbook: `${PORTFOLIO_PLAYBOOK}\nToday is ${todayIst()} (Asia/Kolkata); resolve "yesterday", "this week" etc. from that date.`,
    tools,
  };
}

export function actionAllowed(role, action) {
  if (READ_ACTIONS.has(action)) return true;
  if (action === 'record_number' || action === 'amend_number' || action === 'withdraw_submission') {
    return true;
  }
  if (action === 'show_me' || action === 'update_me') return true;
  if (action === 'decide_escalation' || action === 'set_target') return role === 'owner';
  if (action === 'add_kpi' || action === 'update_kpi' || action === 'retire_kpi') return role === 'owner';
  if (action === 'assign_kpi_owner') {
    return role === 'owner' || role === 'manager' || role === 'vice_manager';
  }
  if (action === 'add_person' || action === 'update_person' || action === 'remove_person') {
    return role === 'owner' || role === 'manager' || role === 'vice_manager';
  }
  if (action === 'validate_submission') {
    return canReviewSubmissions({ role });
  }
  if (action === 'lock_day') return canLockDay({ role });
  if (action === 'update_org') {
    return role === 'owner' || role === 'manager' || role === 'vice_manager';
  }
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Models sometimes pass words ("daily", "today") as dates; drop anything that is not YYYY-MM-DD. */
function cleanDates(body) {
  const out = { ...body };
  for (const key of ['date', 'period', 'period_date', 'from', 'to']) {
    if (out[key] != null && !ISO_DATE.test(String(out[key]).trim())) delete out[key];
  }
  return out;
}

export async function dispatchAgentTool(client, membership, rawBody, logToolCall) {
  const body = cleanDates(rawBody);
  assertHeadersMatch(membership, { headers: body._headers ?? {} });
  const action = body.action;
  const allowed = actionAllowed(membership.role, action);
  await logToolCall(action, body, allowed);
  if (!allowed) {
    return { error: { code: 'forbidden', message: 'Action not permitted for this role.' } };
  }

  switch (action) {
    case 'check_readiness':
      return getReadiness(client, membership, body.org_slug);
    case 'check_day':
      return getOrgStatus(client, membership, body.org_slug, body.date);
    case 'show_kpi':
      return getKpi(client, membership, body.org_slug, body.kpi_code, body.period ?? body.date ?? body.period_date);
    case 'list_kpis':
      return listKpis(client, membership, body.org_slug);
    case 'list_waiting':
      return listWaiting(client, membership, body.org_slug, body.date);
    case 'list_off_track':
      return listBreaches(client, membership, body.org_slug, body.severity, body.date ?? body.period_date);
    case 'who_owns':
      return whoOwns(client, membership, body.org_slug, body.kpi_code);
    case 'find_person':
      return findPerson(client, membership, body.name, body.org_slug);
    case 'list_escalations':
      return listEscalations(client, membership, body.org_slug);
    case 'list_orgs':
      return listOrgs(client, membership);
    case 'show_org':
      return showOrg(client, membership, body.org_slug);
    case 'list_people':
      return listPeopleInOrg(client, membership, body.org_slug);
    case 'list_scores':
      return listScores(client, membership, {
        org_slug: body.org_slug,
        from: body.from ?? body.date ?? body.period_date ?? new Date().toISOString().slice(0, 10),
        to: body.to ?? body.date ?? body.period_date ?? body.from ?? new Date().toISOString().slice(0, 10),
      });
    case 'list_pending':
      return listPending(client, membership, body.org_slug, body.date);
    case 'show_me':
      return showMe(membership.id);
    case 'record_number':
      return recordNumber(client, membership, body);
    case 'set_target':
      return setTargetByCode(client, membership, body);
    case 'decide_escalation':
      return decideEscalation(client, membership, body);
    case 'add_kpi':
      return addKpi(client, membership, body.org_slug, body);
    case 'update_kpi':
      return updateKpiRegister(client, membership, body.kpi_code ?? body.kpi_id, body, body.org_slug);
    case 'assign_kpi_owner':
      return assignKpiOwner(client, membership, body.kpi_code ?? body.kpi_id, body, body.org_slug);
    case 'retire_kpi':
      return retireKpi(client, membership, body.kpi_code ?? body.kpi_id, body.org_slug);
    case 'add_person':
      return addPerson(client, membership, body.org_slug, body);
    case 'update_person':
      return updatePerson(client, membership, body.membership_id ?? body.person_id, body);
    case 'remove_person':
      return removePerson(client, membership, body.membership_id ?? body.person_id);
    case 'amend_number':
      return amendNumber(client, membership, body.submission_id, body.value);
    case 'withdraw_submission':
      return withdrawSubmission(client, membership, body.submission_id);
    case 'validate_submission':
      return validateSubmission(client, membership, body.submission_id, body);
    case 'lock_day':
      return lockDay(client, membership, body.org_slug, body.period_date ?? body.date);
    case 'update_org':
      return updateOrg(client, membership, body.org_slug, body);
    case 'update_me':
      return updateMe(client, membership, body);
    default:
      return { error: { code: 'unknown_action', message: `Unknown action ${action}` } };
  }
}

async function getReadiness(client, membership, orgSlug) {
  const params = [];
  let orgClauseUnnamed = '';
  let orgClauseKpi = '';
  if (membership.role === 'owner') {
    if (orgSlug) {
      params.push(orgSlug);
      orgClauseUnnamed = 'AND o.slug = $1';
      orgClauseKpi = 'AND o.slug = $1';
    }
  } else {
    params.push(membership.org_id);
    orgClauseUnnamed = 'AND o.id = $1';
    orgClauseKpi = 'AND o.id = $1';
  }
  const { rows: unnamed } = await client.query(
    `SELECT o.short_name AS org, count(*)::int AS people FROM memberships m
     JOIN organisations o ON o.id = m.org_id
     WHERE m.state = 'pending_name' ${orgClauseUnnamed}
     GROUP BY o.short_name ORDER BY 2 DESC`,
    params,
  );
  const { rows: nullTargets2 } = await client.query(
    `SELECT o.short_name AS org, count(*)::int AS kpis FROM kpis k
     JOIN organisations o ON o.id = k.org_id
     WHERE k.target IS NULL AND k.unmeasured = false AND k.status = 'active' ${orgClauseKpi}
     GROUP BY o.short_name ORDER BY 2 DESC`,
    params,
  );
  return {
    people_still_unnamed: unnamed,
    kpis_without_goal: nullTargets2,
    note: 'Setup gaps, not performance. people_still_unnamed are placeholder team members (e.g. "Associate 1") awaiting real names; kpis_without_goal are measures with no goal set.',
  };
}

async function getOrgStatus(client, membership, orgSlug, date) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  if (!orgId) {
    return {
      error: {
        code: 'org_required',
        message: 'check_day is per organisation: pass org_slug. For the whole portfolio use list_off_track. Do not report anything from this call.',
      },
    };
  }
  const period = date ?? new Date().toISOString().slice(0, 10);
  const { rows: lock } = await client.query(
    `SELECT locked_at FROM signoffs WHERE org_id = $1 AND period_date = $2`,
    [orgId, period],
  );
  // Each KPI counted once, at its worst colour across cadences.
  const { rows: perKpi } = await client.query(
    `SELECT kpi_id,
            CASE WHEN bool_or(rag = 'red') THEN 'bad'
                 WHEN bool_or(rag = 'amber') THEN 'watch'
                 WHEN bool_or(rag = 'green') THEN 'good'
                 ELSE 'unscored' END AS colour
     FROM scores WHERE org_id = $1 AND period_date = $2 GROUP BY kpi_id`,
    [orgId, period],
  );
  const { rows: unscored } = await client.query(
    `SELECT count(*)::int AS c FROM kpis WHERE org_id = $1 AND target IS NULL AND unmeasured = false`,
    [orgId],
  );
  const { rows: org } = await client.query(`SELECT short_name FROM organisations WHERE id = $1`, [orgId]);
  const count = (c) => perKpi.filter((r) => r.colour === c).length;
  return {
    org: org[0]?.short_name,
    date: period,
    locked: Boolean(lock[0]),
    kpis: { bad: count('bad'), watch: count('watch'), good: count('good') },
    kpis_without_goal: unscored[0]?.c ?? 0,
    note: lock[0] ? undefined : `Day ${period} is not locked, so it is not scored yet.`,
  };
}

async function getKpi(client, membership, orgSlug, kpiCode, period) {
  const periodDate = period ?? new Date().toISOString().slice(0, 10);
  const found = await findKpi(client, membership, kpiCode, orgSlug);
  if (found.error) return found;
  const rows = [found.kpi];
  const k = rows[0];
  const goals = (await goalsFor(client, [k.id])).get(k.id) ?? [{ how_often: k.how_often, target: k.target }];
  const { rows: scores } = await client.query(
    `SELECT how_often, value, rag, paced_goal FROM scores WHERE kpi_id = $1 AND period_date = $2`,
    [k.id, periodDate],
  );
  const byCadence = new Map(scores.map((r) => [r.how_often, r]));
  return {
    kpi: {
      code: k.code,
      name: k.name,
      unit: k.unit,
      entered: k.how_often,
      date: periodDate,
      cadences: goals.map((g) => {
        const sc = byCadence.get(g.how_often);
        return {
          how_often: g.how_often,
          goal: g.target,
          goal_to_date: sc?.paced_goal ?? null,
          value_to_date: sc?.value ?? null,
          colour: sc ? RAG_WORDS[sc.rag] ?? sc.rag : 'not scored (day not locked)',
        };
      }),
      bands: BANDS_NOTE,
    },
  };
}

async function listKpis(client, membership, orgSlug) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  if (!orgId) {
    return { error: { code: 'not_found', message: 'Organisation not in scope. Pass org_slug.' } };
  }
  const { rows: orgRows } = await client.query(
    `SELECT slug, short_name FROM organisations WHERE id = $1`,
    [orgId],
  );
  const { rows } = await client.query(
    `SELECT k.id, k.code, k.name, k.unit, k.how_often, k.target,
            u.full_name AS owner_name, m.role AS owner_role
     FROM kpis k
     LEFT JOIN memberships m ON m.id = k.owner_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE k.org_id = $1 AND k.status = 'active'
     ORDER BY k.code`,
    [orgId],
  );
  const goals = await goalsFor(client, rows.map((k) => k.id));
  return {
    org: orgRows[0],
    bands: BANDS_NOTE,
    kpis: rows.map((k) => ({
      code: k.code,
      name: k.name,
      unit: k.unit,
      entered: k.how_often,
      goals: Object.fromEntries(
        (goals.get(k.id) ?? [{ how_often: k.how_often, target: k.target }]).map((g) => [CADENCE_SHORT[g.how_often] ?? g.how_often, g.target]),
      ),
      owner_name: k.owner_name,
      owner_role: k.owner_role,
    })),
    count: rows.length,
  };
}

async function listWaiting(client, membership, orgSlug, date) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  const period = date ?? new Date().toISOString().slice(0, 10);
  const params = [period];
  let orgClause = '';
  if (orgId) {
    params.push(orgId);
    orgClause = 'AND s.org_id = $2';
  } else if (membership.role !== 'owner') {
    return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  }
  const { rows } = await client.query(
    `SELECT s.id AS submission_id, u.full_name, k.code, k.name, s.value, s.state, s.period_date
     FROM submissions s
     JOIN kpis k ON k.id = s.kpi_id
     JOIN memberships m ON m.id = s.submitted_by
     JOIN users u ON u.id = m.user_id
     WHERE s.period_date = $1 AND s.state <> 'locked' ${orgClause}`,
    params,
  );
  return { waiting: rows };
}

async function whoOwns(client, membership, orgSlug, kpiCode) {
  const found = await findKpi(client, membership, kpiCode, orgSlug);
  if (found.error) return found;
  const { rows } = await client.query(
    `SELECT u.full_name, m.role, o.slug, o.short_name, k.code, k.name
     FROM kpis k
     JOIN organisations o ON o.id = k.org_id
     LEFT JOIN memberships m ON m.id = k.owner_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE k.id = $1`,
    [found.kpi.id],
  );
  return { owner: rows[0] };
}

async function findPerson(client, membership, name, orgSlug) {
  if (!name) return { error: { code: 'invalid', message: 'Name is required' } };
  const orgId = await resolveOrgId(client, membership, orgSlug);
  const params = [`%${name}%`];
  let orgClause = '';
  if (orgId) {
    params.push(orgId);
    orgClause = 'AND m.org_id = $2';
  } else if (membership.role !== 'owner') {
    return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  }
  const { rows } = await client.query(
    `SELECT u.full_name, m.title, m.role, m.state, o.short_name
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN organisations o ON o.id = m.org_id
     WHERE u.full_name ILIKE $1 AND m.state <> 'inactive' ${orgClause}
     LIMIT 8`,
    params,
  );
  return { people: rows };
}

async function listEscalations(client, membership, orgSlug) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  const params = [];
  let orgClause = '';
  if (orgId) {
    params.push(orgId);
    orgClause = 'AND e.org_id = $1';
  } else if (membership.role !== 'owner') {
    return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  }
  const { rows } = await client.query(
    `SELECT e.id, e.kind, e.body, e.state, o.slug
     FROM escalations e
     LEFT JOIN organisations o ON o.id = e.org_id
     WHERE e.state = 'open' ${orgClause}
     ORDER BY e.created_at DESC`,
    params,
  );
  return { escalations: rows };
}

async function decideEscalation(client, membership, body) {
  const { rows } = await client.query(
    `UPDATE escalations SET state = 'decided', decision = $2, decided_at = now()
     WHERE id = $1 AND state = 'open'
     RETURNING id, decision, state`,
    [body.escalation_id, body.decision ?? 'accepted'],
  );
  if (!rows[0]) return { error: { code: 'not_found', message: 'Open escalation not found' } };
  return { escalation: rows[0] };
}

async function listPending(client, membership, orgSlug, date) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  if (!orgId) return { error: { code: 'not_found', message: 'Organisation not in scope' } };
  const period = date ?? new Date().toISOString().slice(0, 10);
  const { rows } = await client.query(
    `SELECT m.id, u.full_name, k.code, k.name
     FROM kpis k
     JOIN memberships m ON m.id = k.owner_id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN submissions s ON s.kpi_id = k.id AND s.period_date = $2 AND s.submitted_by = m.id
     WHERE k.org_id = $1 AND (s.id IS NULL OR s.state = 'draft')`,
    [orgId, period],
  );
  return { pending: rows };
}

async function listBreaches(client, membership, orgSlug, severity, date) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  const period = date ?? new Date().toISOString().slice(0, 10);
  let sql = `SELECT o.short_name AS org, k.code, k.name, k.unit, s.how_often, s.value AS value_to_date, s.goal, s.paced_goal AS goal_to_date, s.rag FROM scores s JOIN kpis k ON k.id = s.kpi_id JOIN organisations o ON o.id = k.org_id WHERE s.period_date = $1 AND s.rag IN ('red','amber')`;
  const params = [period];
  if (orgId) {
    sql += ` AND s.org_id = $2`;
    params.push(orgId);
  } else if (membership.role !== 'owner') {
    sql += ` AND s.org_id = $2`;
    params.push(membership.org_id);
  }
  if (severity === 'red') sql += ` AND s.rag = 'red'`;
  sql += ` ORDER BY s.rag DESC, k.code`;
  const { rows } = await client.query(sql, params);
  // One entry per KPI at its worst cadence (bad before watch; day before week/month/quarter),
  // so "worst N" means N different KPIs. Other off-track cadences ride along.
  const CAD_ORDER = { 'Every day': 0, 'Every week': 1, 'Every month': 2, 'Every quarter': 3 };
  const rank = (r) => (r.rag === 'red' ? 0 : 10) + (CAD_ORDER[r.how_often] ?? 9);
  const byKpi = new Map();
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b))) {
    const cadence = CADENCE_SHORT[r.how_often] ?? r.how_often;
    const colour = RAG_WORDS[r.rag] ?? r.rag;
    const seen = byKpi.get(r.code);
    if (seen) {
      seen.also_off_track.push(`${cadence} (${colour})`);
      continue;
    }
    byKpi.set(r.code, {
      org: r.org,
      kpi: r.name,
      unit: r.unit,
      cadence,
      value_to_date: r.value_to_date,
      goal_to_date: r.goal_to_date ?? r.goal,
      colour,
      also_off_track: [],
    });
  }
  const off = [...byKpi.values()];
  return {
    date: period,
    counts: { bad: off.filter((k) => k.colour === 'bad').length, watch: off.filter((k) => k.colour === 'watch').length },
    off_track: off,
    note: off.length ? 'Sorted worst first; one row per KPI.' : `Nothing scored watch or bad on ${period} (only locked days are scored).`,
  };
}

export { scoreOrgDay, READ_ACTIONS, WRITE_ACTIONS };
