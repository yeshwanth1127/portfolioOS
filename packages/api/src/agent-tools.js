import { todayIn } from './core/dates.js';
import { assertHeadersMatch } from './auth.js';
import { BANDS_NOTE, scoreOrgDay } from './scoring.js';
import { canRoleGate } from './core/permissions/can.js';
import { TOOL_OWNER_ONLY, TOOL_TO_MATRIX_ACTION } from './core/permissions/tool-matrix.js';
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
import { createUnit, listUnitTree } from './modules/units.js';
import { listScores } from './domain/scores.js';
import { lockDay, reopenDay } from './domain/signoffs.js';
import {
  amendNumber,
  recordNumber,
  validateSubmission,
  withdrawSubmission,
} from './domain/submissions.js';
import { INPUT_SCHEMA_BY_ACTION, REQUIRES_BY_ACTION } from './agent-tool-schemas.js';
import { calendarFeed, createEvent, updateEvent } from './modules/calendar.js';
import {
  commentOnTask,
  completeTask,
  createProject,
  createTask,
  listProjects,
  listTasks,
  myWork,
  postProjectUpdate,
} from './modules/projects.js';
import { calendarIntegrationStatus } from './modules/expansion.js';
import { clock } from './modules/attendance.js';
import { createReport, queueReportRun, reportDataForAgent } from './modules/reports/index.js';
import { REPORT_PLAYBOOK } from './modules/reports/narrative.js';
import { TYPE_BY_ID } from './modules/reports/types.js';
import { findOrg } from './domain/lookup.js';
import {
  MEETING_PLAYBOOK,
  listMeetingsForAgent,
  meetingContextForAgent,
  meetingNotesForAgent,
  meetingTranscriptForAgent,
} from './modules/meetings/assistant.js';

const RAG_WORDS = { green: 'good', amber: 'watch', red: 'bad', unscored: 'unscored' };

const READ_ACTIONS = new Set([
  'list_meetings',
  'meeting_notes',
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
  'list_units',
  'show_org',
  'list_people',
  'list_scores',
  'list_pending',
  'show_me',
  'list_events',
  'list_projects',
  'list_tasks',
  'my_tasks',
  'connect_calendar',
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
  'add_unit',
  'update_person',
  'remove_person',
  'amend_number',
  'withdraw_submission',
  'validate_submission',
  'lock_day',
  'reopen_day',
  'update_org',
  'update_me',
  'add_event',
  'move_event',
  'create_project',
  'create_task',
  'complete_task',
  'comment_on_task',
  'post_project_update',
  'generate_report',
  'clock_in',
  'clock_out',
]);

/** Tools served only on a report-drafting run token (catalogue profile "report"). */
const REPORT_PROFILE_ACTIONS = new Set(['report_data']);
/** Tools served only on a Meeting Assistant run token (catalogue profile "meeting"); the meeting comes from the token. */
const MEETING_PROFILE_ACTIONS = new Set(['meeting_context', 'meeting_transcript']);
/** Safe reads the Meeting Assistant also gets (who someone is, what a KPI means). */
const MEETING_PROFILE_READS = ['show_me', 'find_person', 'list_kpis', 'show_kpi', 'list_off_track', 'meeting_notes'];

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
  list_units: 'List unit tree',
  show_org: 'Show organisation',
  list_people: 'List people',
  list_scores: 'List scores',
  list_pending: 'Pending numbers',
  show_me: 'My account',
  list_events: 'List calendar',
  list_projects: 'List projects',
  list_tasks: 'List project tasks',
  my_tasks: 'My open tasks',
  create_project: 'Create project',
  create_task: 'Create task',
  complete_task: 'Complete task',
  comment_on_task: 'Comment on task',
  post_project_update: 'Post project update',
  connect_calendar: 'Calendar integration status',
  add_event: 'Add calendar event',
  move_event: 'Update calendar event',
  record_number: 'Record number',
  set_target: 'Set goal',
  decide_escalation: 'Decide',
  add_kpi: 'Add KPI',
  update_kpi: 'Update KPI',
  assign_kpi_owner: 'Assign KPI owner',
  retire_kpi: 'Retire KPI',
  add_person: 'Add person',
  add_unit: 'Add unit',
  update_person: 'Update person',
  remove_person: 'Remove person',
  amend_number: 'Amend number',
  withdraw_submission: 'Withdraw submission',
  validate_submission: 'Validate submission',
  lock_day: 'Close day',
  reopen_day: 'Reopen day',
  update_org: 'Update organisation',
  update_me: 'Update account',
  generate_report: 'Generate report',
  clock_in: 'Clock in',
  clock_out: 'Clock out',
  report_data: 'Report figures',
  meeting_context: 'Meeting details',
  list_meetings: 'List meetings',
  meeting_notes: 'Meeting notes',
  meeting_transcript: 'Meeting transcript',
};

const ACTION_SUMMARIES = {
  check_readiness: 'Counts unnamed people and KPIs missing goals (not a KPI list).',
  check_day: 'Whether the org day is closed plus rag counts for a date.',
  show_kpi: 'One KPI: per-cadence goals (day/week/month/quarter), value to date and good/watch/bad for a date.',
  list_kpis: 'All active KPIs for an org (requires org_slug), each with its tracked cadences and goal per cadence.',
  list_waiting: 'Submissions not closed yet for a date, with submission_id (use it for validate_submission / amend_number / withdraw_submission).',
  list_off_track: 'KPIs in watch or bad on one day, per cadence (day/week/month/quarter to date). Without a date it uses the latest scored day (only closed days are scored) and says which day; pass date YYYY-MM-DD for another day.',
  who_owns: 'Who owns a kpi_code.',
  find_person: 'Search people by name (partial).',
  list_escalations: 'Open escalations.',
  list_orgs: 'Organisations visible to this caller, with total and counts by kind (organisation, department, test). Quote the counts.',
  list_units: 'Typed unit tree for the workspace (organisation → branch → department → team).',
  show_org: 'One org summary and KPI count.',
  list_people: 'Full team roster for an org.',
  list_scores: 'Score rows for a date range (requires from/to).',
  list_pending: 'Owners who have not submitted today.',
  show_me: 'Caller profile, role, and org.',
  list_events: 'Calendar feed for a date range (events + close-the-day reminders).',
  add_event: 'Create a calendar event (title, start/end, optional org_slug, participants).',
  move_event: 'Update an event by event_id (time, title, participants, reminders).',
  record_number: 'Submit a KPI value for a date.',
  set_target: 'Set the goal for one cadence: kpi_code, value, how_often (Every day|Every week|Every month|Every quarter). Adds that cadence if not tracked yet (owner).',
  decide_escalation: 'Close an open escalation (owner).',
  add_kpi: 'Add a measure to the register (owner).',
  update_kpi: 'Change KPI name or unit, rollup_method (sum|average|latest), or replace tracked cadences with goals: [{how_often, target}] (owner).',
  assign_kpi_owner: 'Assign who owns a KPI (owner or manager).',
  retire_kpi: 'Retire a KPI from the active register (owner).',
  add_person: 'Add someone to the org (manager or owner).',
  add_unit: 'Add a branch, department, or team under parent_id (manager or owner).',
  update_person: 'Edit a person role, title, or reports-to.',
  remove_person: 'Deactivate a person on the roster.',
  amend_number: 'Correct a submitted value (submission_id, value, reason). The corrected number goes back for approval. Not possible in a closed day.',
  withdraw_submission: 'Delete a submission before the day is closed.',
  validate_submission: 'Accept or reject a submission (manager or team lead).',
  lock_day: 'Close an org day (org_slug, date): approved numbers are closed and scored; numbers still waiting for review are left out and reported (owner or manager).',
  reopen_day: 'Reopen a closed org day so numbers can be corrected (org_slug, date, reason). Its scores are removed until it is closed again (owner or manager).',
  update_org: 'Edit org name or positioning text.',
  update_me: 'Update caller name or WhatsApp phone.',
  connect_calendar: 'Read-only: Google/Outlook calendar connect status for the workspace (OAuth is owner-only via HTTP).',
  generate_report: `Start a downloadable report (report_type: ${[...TYPE_BY_ID.keys()].join('|')}; from/to YYYY-MM-DD; optional org_slug or person_name). It is ready in the Reports page in about a minute; on WhatsApp the summary is sent back when ready.`,
  clock_in: 'Clock the caller in for today (attendance).',
  clock_out: 'Clock the caller out for today (attendance).',
  report_data: "The figures of the report being drafted: totals and top rows per dataset. Quote only these numbers.",
  list_meetings: 'Meetings in a date range (default: two weeks either side of today): title, when, host, who attended, whether notes are ready.',
  meeting_notes: 'Notes from an ended meeting found by title and/or date: summary, decisions, action items with owners.',
  meeting_context: 'This meeting: title, agenda, host, and the people invited or present (names as to use them).',
  meeting_transcript: 'What was said in this meeting, one line per utterance: [mm:ss] Speaker: words. No arguments.',
};

const REPORT_TOOL_SCHEMA = { type: 'object', properties: { action: { const: 'report_data' } } };

const PORTFOLIO_PLAYBOOK = `You answer questions about the Sona portfolio. Call portfolio_os with the exact action name. Never invent a number.
Every change (goal, number, KPI, person, closing a day) must be made by calling the write tool in THIS turn, even if it was discussed earlier. Only say it was done if that call returned ok; otherwise say it was not saved and why.
Colours: good = at or above the goal; watch = from 80% of goal; bad = under 80%.
Org slugs (owner): tms, uatc (Unreal ATC), s3dx (Sonastar3Dx), pats, sai, comms, scale. Dates ISO, timezone Asia/Kolkata, currency INR.
A KPI can be tracked every day, week, month and/or quarter, each with its own goal. Numbers are submitted at the most frequent cadence; week/month/quarter values are rolled up (sums judged on pace to date).
Managers see their org; members usually record only KPIs they own. Use validate_submission then lock_day to close a day. A closed day cannot be changed: if a number in it is wrong, reopen_day (with a reason), correct it, approve it, and lock_day again. When talking to people say "close" / "closed", never "lock" / "locked". A corrected number always needs approval again.
Delivery: my_tasks for open work; list_tasks needs project_id; complete_task with task_id; comment_on_task with task_id and body; post_project_update with project_id and body (manager updates).
For meetings ("what did we decide in Monday's review?", "my action items from the hiring sync"), use meeting_notes with words from the title and/or the date; list_meetings shows what happened when.
For a portfolio or org summary, report performance: list_off_track (omit org_slug for the whole portfolio), check_day per org, check_readiness. Do not describe org profiles unless asked.
Dates: pass YYYY-MM-DD or omit (defaults to today).
Reports: generate_report starts a report (KPI targets, reporting, tasks, projects, workload, people, attendance, sign-ins, or a personal work report "my_work") for a date range; tell the user it will be ready on the Reports page shortly. "@ in" / "@ out" or "clock me in/out" = clock_in / clock_out.
kpi_code accepts the exact code (comms.creatives) or the KPI name ("creatives delivered"); org_slug accepts the slug or the org name. If a call returns candidates, pick the right code and retry.

Always pass the date the user means (the message carries it as YYYY-MM-DD) to every tool that takes one.

REPLY FORMAT — plain text; the app turns the [tags] below into icons. Never use emoji, markdown (**, #, backticks, tables) or JSON.
Line 1: short headline that names what was asked plus the date, no full stop (e.g. "Portfolio on 11 Nov", "Off track at PATS, 11 Nov"). Then a blank line.
For a broad "how are we doing" question: one [locked]/[open] line per organisation (closed first), then the 3 worst KPI lines. Then only these line types:
  [bad] PATS · Drone serviceability — 66.7% of 90%, day   (one KPI; tag = [bad], [watch], [good] or [unscored])
  [locked] TMS — closed · 2 bad, 1 watch, 5 good          (day status; [open] TMS — not closed)
  [person] Anju Raj — PATS manager                        (a person)
  [saved] Saved — daily goal for Drone serviceability is now 85%   (only if the write tool returned ok; else "Not saved — <reason>")
  [-] anything else, one short line
  Next: <one useful follow-up>                            (optional, last line)
Answer only what was asked: "worst 3" is exactly 3 KPI lines (plus an optional Next line) — no extra status, people or commentary lines. Every number must come from a tool result in this turn.
Use the org names and KPI names exactly as the tools return them. Never show codes or ids. Say good/watch/bad, never green/amber/red. Indian number grouping, ₹ for INR, 1 decimal. Max 8 item lines, then "+N more".`;

/** Machine-readable catalogue for agent runtimes (ADK must discover, not hardcode). */
export function getToolCatalog(role = null, profile = null) {
  const describe = (action, mutating) => {
    const allowed = role == null ? true : actionAllowed(role, action);
    const input_schema =
      action === 'report_data'
        ? REPORT_TOOL_SCHEMA
        : INPUT_SCHEMA_BY_ACTION[action] ?? { type: 'object', properties: { action: { const: action } } };
    const requires = REQUIRES_BY_ACTION[action];
    return {
      action,
      label: ACTION_LABELS[action] ?? action,
      summary: ACTION_SUMMARIES[action] ?? ACTION_LABELS[action] ?? action,
      mutating,
      allowed,
      input_schema,
      ...(requires ? { requires } : {}),
    };
  };
  const all = [
    ...[...READ_ACTIONS].map((a) => describe(a, false)),
    ...[...WRITE_ACTIONS].map((a) => describe(a, true)),
  ];
  if (profile === 'meeting') {
    return {
      capability: 'portfolio_os',
      invoke: 'POST /agent/tools/portfolio_os',
      profile: 'meeting',
      playbook: `${MEETING_PLAYBOOK}\nToday is ${new Date(`${todayIn()}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${todayIn()} (Asia/Kolkata). Resolve "Friday", "next week" etc. from that date; a weekday means the next one on or after today.`,
      tools: [
        ...[...MEETING_PROFILE_ACTIONS].map((a) => describe(a, false)),
        ...MEETING_PROFILE_READS.filter((a) => READ_ACTIONS.has(a) || SELF_SERVICE_ACTIONS.has(a)).map((a) => describe(a, false)),
      ],
    };
  }
  if (profile === 'report') {
    return {
      capability: 'portfolio_os',
      invoke: 'POST /agent/tools/portfolio_os',
      profile: 'report',
      playbook: REPORT_PLAYBOOK,
      tools: [...REPORT_PROFILE_ACTIONS].map((a) => describe(a, false)),
    };
  }
  const tools = role == null ? all : all.filter((t) => t.allowed);
  return {
    capability: 'portfolio_os',
    invoke: 'POST /agent/tools/portfolio_os',
    playbook: `${PORTFOLIO_PLAYBOOK}\nToday is ${todayIn()} (Asia/Kolkata); resolve "yesterday", "this week" etc. from that date.`,
    tools,
  };
}

const SELF_SERVICE_ACTIONS = new Set(['show_me', 'update_me', 'generate_report', 'clock_in', 'clock_out']);
/** Writes allowed at role gate; resource rules enforced in domain (same as ungated HTTP PATCH /comments). */
const DOMAIN_GATED_WRITES = new Set(['complete_task', 'comment_on_task']);

/** Role gate for agent tools (full `can()` runs in domain). */
export function actionAllowed(role, action) {
  if (READ_ACTIONS.has(action)) return true;
  if (REPORT_PROFILE_ACTIONS.has(action)) return true;
  if (MEETING_PROFILE_ACTIONS.has(action)) return true;
  if (SELF_SERVICE_ACTIONS.has(action)) return true;
  if (DOMAIN_GATED_WRITES.has(action)) return true;
  if (TOOL_OWNER_ONLY.has(action)) return canRoleGate({ role }, 'kpi.edit');
  const matrixAction = TOOL_TO_MATRIX_ACTION[action];
  if (matrixAction) return canRoleGate({ role }, matrixAction);
  return false;
}

export { TOOL_TO_MATRIX_ACTION };

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
      return agentOrgList(await listOrgs(client, membership));
    case 'list_units':
      return listUnitTree(client, membership);
    case 'show_org':
      return showOrg(client, membership, body.org_slug);
    case 'list_people':
      return listPeopleInOrg(client, membership, body.org_slug);
    case 'list_scores':
      return listScores(client, membership, {
        org_slug: body.org_slug,
        from: body.from ?? body.date ?? body.period_date ?? todayIn(),
        to: body.to ?? body.date ?? body.period_date ?? body.from ?? todayIn(),
      });
    case 'list_pending':
      return listPending(client, membership, body.org_slug, body.date);
    case 'show_me':
      return showMe(membership.id);
    case 'list_events':
      return calendarFeed(client, membership, { from: body.from, to: body.to });
    case 'list_projects':
      return listProjects(client, membership);
    case 'list_tasks':
      return listTasks(client, membership, body.project_id);
    case 'my_tasks':
      return myWork(client, membership);
    case 'create_project':
      return createProject(client, membership, body);
    case 'create_task':
      return createTask(client, membership, body.project_id, body);
    case 'complete_task':
      return completeTask(client, membership, body.task_id);
    case 'comment_on_task':
      return commentOnTask(client, membership, body);
    case 'post_project_update':
      return postProjectUpdate(client, membership, body.project_id, body);
    case 'connect_calendar':
      return calendarIntegrationStatus(client, membership);
    case 'add_event':
      return createEvent(client, membership, body);
    case 'move_event':
      return updateEvent(client, membership, body.event_id, body);
    case 'record_number':
      return recordNumber(client, membership, { ...body, period_date: body.period_date ?? body.date });
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
    case 'add_unit':
      return createUnit(client, membership, body);
    case 'update_person':
      return updatePerson(client, membership, body.membership_id ?? body.person_id, body);
    case 'remove_person':
      return removePerson(client, membership, body.membership_id ?? body.person_id);
    case 'amend_number':
      return amendNumber(client, membership, body.submission_id, body.value, body.reason);
    case 'withdraw_submission':
      return withdrawSubmission(client, membership, body.submission_id);
    case 'validate_submission':
      return validateSubmission(client, membership, body.submission_id, body);
    case 'lock_day':
      return lockDay(client, membership, body.org_slug, body.period_date ?? body.date);
    case 'reopen_day':
      return reopenDay(client, membership, body.org_slug, body.period_date ?? body.date, body.reason);
    case 'update_org':
      return updateOrg(client, membership, body.org_slug, body);
    case 'update_me':
      return updateMe(client, membership, body);
    case 'report_data':
      return reportDataForAgent(client, membership, body._run);
    case 'list_meetings':
      return listMeetingsForAgent(client, membership, body);
    case 'meeting_notes':
      return meetingNotesForAgent(client, membership, body);
    case 'meeting_context':
      return meetingContextForAgent(client, membership, body._run);
    case 'meeting_transcript':
      return meetingTranscriptForAgent(client, membership, body._run);
    case 'generate_report':
      return generateReportFromAgent(client, membership, body);
    case 'clock_in':
      return clock(client, membership, { kind: 'in', note: body.note }, body._run?.channel === 'whatsapp' ? 'whatsapp' : 'agent');
    case 'clock_out':
      return clock(client, membership, { kind: 'out', note: body.note }, body._run?.channel === 'whatsapp' ? 'whatsapp' : 'agent');
    default:
      return { error: { code: 'unknown_action', message: `Unknown action ${action}` } };
  }
}

/** generate_report: resolve org / person by name, queue the report, return where to find it. */
async function generateReportFromAgent(client, membership, body) {
  const input = { report_type: body.report_type, from: body.from, to: body.to, instructions: body.instructions };
  if (body.person_name) {
    const { rows } = await client.query(
      `SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.state <> 'inactive' AND u.full_name ILIKE '%' || $1 || '%'
       ORDER BY length(u.full_name) LIMIT 2`,
      [String(body.person_name).trim()],
    );
    if (rows.length !== 1) return { error: { code: 'invalid', message: rows.length ? 'More than one person matches that name.' : 'No person matches that name.' } };
    Object.assign(input, rows[0].id === membership.id ? { scope_kind: 'me' } : { scope_kind: 'person', scope_ref: rows[0].id });
  } else if (body.org_slug) {
    const org = await findOrg(client, body.org_slug);
    if (!org) return { error: { code: 'not_found', message: 'Organisation not found.' } };
    Object.assign(input, { scope_kind: 'org', scope_ref: org.id });
  }
  const channel = body._run?.channel === 'whatsapp' ? 'whatsapp' : 'agent';
  const out = await createReport(client, membership, input, { channel });
  if (out.error) return out;
  await queueReportRun(client, out.report.id, membership.id);
  return {
    ok: true,
    report: { title: out.report.title, from: out.report.period_from, to: out.report.period_to, status: 'queued' },
    where: 'Reports page in Orbit',
  };
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
  const period = date ?? todayIn();
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
    note: lock[0] ? undefined : `Day ${period} is not closed, so it is not scored yet.`,
  };
}

async function getKpi(client, membership, orgSlug, kpiCode, period) {
  const periodDate = period ?? todayIn();
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
          colour: sc ? RAG_WORDS[sc.rag] ?? sc.rag : 'not scored (day not closed)',
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
  const period = date ?? todayIn();
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
  const period = date ?? todayIn();
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

/**
 * The agent's view of list_orgs: a stated count (models miscount long lists) and only the fields
 * needed to answer, with departments and test organisations marked so "how many" is unambiguous.
 */
function agentOrgList(out) {
  if (out?.error) return out;
  const orgs = (out?.orgs ?? []).map((o) => ({
    slug: o.slug,
    name: o.name,
    short_name: o.short_name,
    sector: o.sector,
    kind: o.is_department ? 'department' : /(^|-)test(-|$)/i.test(o.slug) ? 'test' : 'organisation',
    status: o.status,
  }));
  const count = (kind) => orgs.filter((o) => o.kind === kind).length;
  return {
    total: orgs.length,
    counts: { organisations: count('organisation'), departments: count('department'), test: count('test') },
    orgs,
    note: 'Quote these counts; do not count the list yourself.',
  };
}

async function listBreaches(client, membership, orgSlug, severity, date) {
  const orgId = await resolveOrgId(client, membership, orgSlug);
  // No date asked for: use the latest scored day (only closed days are scored, so "today" is
  // usually empty until the day is locked). Same basis as reports' "off track now".
  let period = date ?? todayIn();
  let usedLatest = false;
  if (!date) {
    const scopeId = orgId ?? (membership.role !== 'owner' ? membership.org_id : null);
    const { rows: latest } = await client.query(
      `SELECT max(period_date)::text AS d FROM scores WHERE period_date <= $1${scopeId ? ' AND org_id = $2' : ''}`,
      scopeId ? [period, scopeId] : [period],
    );
    if (latest[0]?.d && latest[0].d !== period) {
      period = latest[0].d;
      usedLatest = true;
    }
  }
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
    note: [
      usedLatest ? `Today is not scored yet (only closed days are scored); this is ${period}, the latest scored day. Say so.` : null,
      off.length ? 'Sorted worst first; one row per KPI.' : `Nothing scored watch or bad on ${period}.`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export { scoreOrgDay, READ_ACTIONS, WRITE_ACTIONS };
