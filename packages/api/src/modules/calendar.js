import jwt from 'jsonwebtoken';
import { config } from '../core/config.js';
import { addDays, todayIn } from '../core/dates.js';
import { CADENCE_SHORT, pacedGoal, periodWindow, rollupValues } from '../cadence.js';
import { computeRag } from '../scoring.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { noteWaMessage } from './commercial/usage.js';
import { cancelQueued, enqueue, registerJob } from '../jobs/queue.js';

/*
 * Calendar (docs/BUILD.md § 6.6): events with participants and reminders, plus derived items
 * (days waiting to be locked) in one feed. Visibility is enforced by RLS: the owner sees all;
 * others see their organisation's events, events they created, and events they are invited to.
 */
const KINDS = ['meeting', 'review', 'visit', 'call', 'deadline', 'other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });

function mayEditEvent(membership, event) {
  const isCreator = event.created_by === membership.id;
  return can(membership, 'calendar.edit', { isCreator, eventOrgId: event.org_id ?? null });
}

function parseInstant(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Validate and normalise an event body. Returns { value } or { error }. */
function readEvent(body, { partial = false } = {}) {
  const b = body ?? {};
  const out = {};
  if (!partial || b.title !== undefined) {
    const title = String(b.title ?? '').trim();
    if (!title) return err('invalid', 'Give the event a title.');
    if (title.length > 200) return err('invalid', 'Keep the title under 200 characters.');
    out.title = title;
  }
  if (!partial || b.kind !== undefined) {
    const kind = b.kind ?? 'meeting';
    if (!KINDS.includes(kind)) return err('invalid', `Kind must be one of: ${KINDS.join(', ')}.`);
    out.kind = kind;
  }
  if (!partial || b.starts_at !== undefined || b.ends_at !== undefined || b.all_day !== undefined) {
    const allDay = Boolean(b.all_day);
    const start = parseInstant(b.starts_at);
    const end = b.ends_at ? parseInstant(b.ends_at) : start && new Date(start.getTime() + (allDay ? 0 : 3600000));
    if (!start || !end) return err('invalid', 'Give a valid start and end time.');
    if (end < start) return err('invalid', 'The event cannot end before it starts.');
    if (end - start > 31 * 86400000) return err('invalid', 'An event can last at most 31 days.');
    Object.assign(out, { starts_at: start, ends_at: end, all_day: allDay });
  }
  for (const key of ['location', 'description']) {
    if (!partial || b[key] !== undefined) out[key] = b[key] ? String(b[key]).trim().slice(0, key === 'location' ? 200 : 4000) : null;
  }
  if (!partial || b.reminder_minutes !== undefined) {
    const list = Array.isArray(b.reminder_minutes) ? b.reminder_minutes : b.reminder_minutes == null ? [30] : [b.reminder_minutes];
    const mins = [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 10080))].sort((x, y) => x - y);
    out.reminder_minutes = mins.slice(0, 5);
  }
  if (!partial || b.org_id !== undefined) {
    if (b.org_id && !UUID.test(String(b.org_id))) return err('invalid', 'Unknown organisation.');
    out.org_id = b.org_id || null;
  }
  if (!partial || b.participant_ids !== undefined) {
    const ids = Array.isArray(b.participant_ids) ? b.participant_ids : [];
    if (ids.some((id) => !UUID.test(String(id)))) return err('invalid', 'Unknown participant.');
    out.participant_ids = [...new Set(ids)].slice(0, 50);
  }
  return { value: out };
}

async function scheduleReminders(client, eventId, startsAt, minutes) {
  await cancelQueued(client, `reminder:${eventId}:`);
  for (const m of minutes) {
    const at = new Date(new Date(startsAt).getTime() - m * 60000);
    if (at < new Date()) continue;
    await enqueue(client, 'event_reminder', { event_id: eventId, minutes: m }, { runAt: at, dedupeKey: `reminder:${eventId}:${m}` });
  }
}

const EVENT_SELECT = `
  SELECT e.id, e.title, e.kind, e.starts_at, e.ends_at, e.all_day, e.location, e.description,
         e.reminder_minutes, e.org_id, o.short_name AS org, e.created_by,
         auth.workspace_member_name(e.created_by) AS created_by_name,
         COALESCE(json_agg(json_build_object('membership_id', p.membership_id, 'name', auth.workspace_member_name(p.membership_id), 'response', p.response)
                  ORDER BY auth.workspace_member_name(p.membership_id)) FILTER (WHERE p.membership_id IS NOT NULL), '[]') AS participants
  FROM calendar_events e
  LEFT JOIN organisations o ON o.id = e.org_id
  LEFT JOIN calendar_event_participants p ON p.event_id = e.id`;

async function loadEvent(client, id) {
  const { rows } = await client.query(`${EVENT_SELECT} WHERE e.id = $1 GROUP BY e.id, o.short_name, e.created_by`, [id]);
  return rows[0] ?? null;
}

async function setParticipants(client, eventId, ids) {
  // Anyone active in the same workspace can be invited (auth.meeting_directory, 030), as with meetings.
  if (ids.length) {
    const { rows } = await client.query(`SELECT id FROM auth.meeting_directory() WHERE id = ANY($1::uuid[])`, [ids]);
    if (rows.length !== ids.length) return err('invalid', 'Some participants could not be found.');
  }
  await client.query(`DELETE FROM calendar_event_participants WHERE event_id = $1 AND NOT (membership_id = ANY($2::uuid[]))`, [eventId, ids]);
  for (const id of ids) {
    await client.query(
      `INSERT INTO calendar_event_participants (event_id, membership_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [eventId, id],
    );
  }
  return { ok: true };
}

export async function createEvent(client, membership, body) {
  if (!can(membership, 'calendar.event.create')) {
    return permissionDenied(membership, 'calendar.event.create');
  }
  const parsed = readEvent(body);
  if (parsed.error) return parsed;
  const v = parsed.value;
  // Non-owners create events in their own organisation (or personal ones without an org).
  if (membership.role !== 'owner' && v.org_id && v.org_id !== membership.org_id) {
    return err('forbidden', 'You can only add events for your own organisation.');
  }
  const orgId = v.org_id ?? (membership.role === 'owner' ? null : membership.org_id);
  const { rows } = await client.query(
    `INSERT INTO calendar_events (workspace_id, org_id, title, kind, starts_at, ends_at, all_day, location, description, reminder_minutes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      membership.workspace_id,
      orgId,
      v.title,
      v.kind,
      v.starts_at,
      v.ends_at,
      v.all_day,
      v.location,
      v.description,
      v.reminder_minutes,
      membership.id,
    ],
  );
  const id = rows[0].id;
  const p = await setParticipants(client, id, v.participant_ids);
  if (p.error) return p;
  await scheduleReminders(client, id, v.starts_at, v.reminder_minutes);
  return { event: await loadEvent(client, id) };
}

async function editableEvent(client, membership, id) {
  if (!UUID.test(String(id ?? ''))) return err('not_found', 'Event not found');
  const { rows } = await client.query(`SELECT * FROM calendar_events WHERE id = $1 FOR UPDATE`, [id]);
  const e = rows[0];
  if (!e) return err('not_found', 'Event not found');
  if (!mayEditEvent(membership, e)) {
    return permissionDenied(membership, 'calendar.edit');
  }
  return { event: e };
}

export async function updateEvent(client, membership, id, body) {
  const found = await editableEvent(client, membership, id);
  if (found.error) return found;
  const parsed = readEvent({ ...found.event, ...body, participant_ids: body?.participant_ids }, { partial: true });
  if (parsed.error) return parsed;
  const v = parsed.value;
  if (membership.role !== 'owner' && v.org_id && v.org_id !== membership.org_id) {
    return err('forbidden', 'You can only move events within your own organisation.');
  }
  const next = { ...found.event, ...v };
  await client.query(
    `UPDATE calendar_events SET title = $2, kind = $3, starts_at = $4, ends_at = $5, all_day = $6, location = $7,
       description = $8, reminder_minutes = $9, org_id = $10, updated_at = now() WHERE id = $1`,
    [id, next.title, next.kind, next.starts_at, next.ends_at, next.all_day, next.location, next.description, next.reminder_minutes, next.org_id],
  );
  if (body?.participant_ids !== undefined) {
    const p = await setParticipants(client, id, v.participant_ids ?? []);
    if (p.error) return p;
  }
  await scheduleReminders(client, id, next.starts_at, next.reminder_minutes);
  return { event: await loadEvent(client, id) };
}

export async function deleteEvent(client, membership, id) {
  const found = await editableEvent(client, membership, id);
  if (found.error) return found;
  await cancelQueued(client, `reminder:${id}:`);
  await client.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
  return { ok: true };
}

export async function respondToEvent(client, membership, id, response) {
  if (!['yes', 'no', 'maybe'].includes(response)) return err('invalid', 'Answer yes, no or maybe.');
  if (!UUID.test(String(id ?? ''))) return err('not_found', 'Event not found');
  const { rowCount } = await client.query(
    `UPDATE calendar_event_participants SET response = $3 WHERE event_id = $1 AND membership_id = $2`,
    [id, membership.id, response],
  );
  if (!rowCount) return err('not_found', 'You are not invited to this event.');
  return { event: await loadEvent(client, id) };
}

/* Target results --------------------------------------------------------------------------- */

const LEVEL_RANK = `CASE level WHEN 'owner' THEN 5 WHEN 'manager' THEN 4 WHEN 'vice_manager' THEN 3
                                WHEN 'team_lead' THEN 2 ELSE 1 END`;
const CADENCE_WORD = { 'Every day': 'daily', 'Every week': 'weekly', 'Every month': 'monthly', 'Every quarter': 'quarterly' };
const RAG_TO_STATUS = { green: 'met', amber: 'close', red: 'missed' };

/** Periods of `cadence` whose last day falls in [start, end] and that have begun by `today`. */
function periodsEndingIn(cadence, start, end, today) {
  const out = [];
  if (cadence === 'Every day') {
    for (let d = start; d <= end && d <= today; d = addDays(d, 1)) out.push(periodWindow(cadence, d));
    return out;
  }
  let w = periodWindow(cadence, start);
  while (w.end <= end) {
    if (w.end >= start && w.start <= today) out.push(w);
    w = periodWindow(cadence, addDays(w.end, 1));
  }
  return out;
}

/**
 * One item per organisation and period: how each KPI did against the goal set for that cadence.
 * Daily results sit on their day; week / month / quarter results on the period's last day
 * (a period still running is judged on pace as of today). Numbers count once validated or
 * locked, the same rule the Overview scoring uses; anything still waiting is reported as such.
 */
async function targetItems(client, start, end, today) {
  const { rows: goals } = await client.query(
    `SELECT k.id, k.org_id, k.name, k.unit, k.direction, k.rollup_method, k.how_often, k.unmeasured,
            o.short_name AS org, o.slug AS org_slug, g.how_often AS cadence, g.target AS goal
     FROM kpi_goals g
     JOIN kpis k ON k.id = g.kpi_id AND k.status = 'active'
     JOIN organisations o ON o.id = k.org_id
     WHERE g.target IS NOT NULL
     ORDER BY o.short_name, k.name`,
  );
  if (!goals.length) return [];

  // Every period we will report, per cadence in use.
  const cadences = [...new Set(goals.map((g) => g.cadence))];
  const periods = Object.fromEntries(cadences.map((c) => [c, periodsEndingIn(c, start, end, today)]));
  const all = Object.values(periods).flat();
  if (!all.length) return [];
  const fetchFrom = all.reduce((m, w) => (w.start < m ? w.start : m), start);
  const fetchTo = end < today ? end : today;

  const { rows: subs } = await client.query(
    `SELECT DISTINCT ON (kpi_id, period_date) kpi_id, period_date, value, state
     FROM submissions
     WHERE kpi_id = ANY($1::uuid[]) AND period_date BETWEEN $2 AND $3
       AND value IS NOT NULL AND state IN ('submitted', 'validated', 'locked')
     ORDER BY kpi_id, period_date, (state IN ('validated', 'locked')) DESC, ${LEVEL_RANK} DESC`,
    [[...new Set(goals.map((g) => g.id))], fetchFrom, fetchTo],
  );
  const byKpi = new Map();
  for (const s of subs) {
    if (!byKpi.has(s.kpi_id)) byKpi.set(s.kpi_id, []);
    byKpi.get(s.kpi_id).push(s);
  }

  const groups = new Map(); // org|cadence|end → item
  for (const g of goals) {
    for (const w of periods[g.cadence]) {
      const upTo = w.end < today ? w.end : today;
      const inProgress = w.end > today;
      const rows = (byKpi.get(g.id) ?? []).filter((s) => s.period_date >= w.start && s.period_date <= upTo);
      const approved = rows.filter((s) => s.state !== 'submitted');
      const actual = rollupValues(g, approved);
      const goal = Number(g.goal);
      const judgedAgainst = inProgress ? pacedGoal(g, g.cadence, goal, today) : goal;
      let status = g.unmeasured ? 'unscored' : RAG_TO_STATUS[computeRag({ ...g, target: judgedAgainst }, actual)] ?? 'no_data';
      if (status === 'no_data' && rows.length > approved.length) status = 'pending';

      // Daily results only for days the organisation actually reported; longer periods always.
      const key = `${g.org_id}|${g.cadence}|${w.end}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: `target:${g.org_id}:${CADENCE_SHORT[g.cadence]}:${w.end}`,
          source: 'target',
          kind: 'target',
          org: g.org,
          org_slug: g.org_slug,
          cadence: CADENCE_SHORT[g.cadence],
          title: `${g.org} · ${CADENCE_WORD[g.cadence]} targets`,
          date: w.end,
          period_start: w.start,
          period_end: w.end,
          in_progress: inProgress,
          all_day: true,
          editable: false,
          reported: false,
          kpis: [],
        });
      }
      const item = groups.get(key);
      if (rows.length) item.reported = true;
      item.kpis.push({
        kpi_id: g.id,
        name: g.name,
        unit: g.unit,
        direction: g.direction,
        actual,
        goal,
        judged_against: judgedAgainst,
        status,
      });
    }
  }

  const items = [];
  for (const item of groups.values()) {
    if (item.cadence === 'day' && !item.reported) continue;
    const count = (st) => item.kpis.filter((k) => k.status === st).length;
    const summary = { met: count('met'), close: count('close'), missed: count('missed'), pending: count('pending'), no_data: count('no_data') };
    const scored = summary.met + summary.close + summary.missed;
    item.summary = summary;
    item.status = !scored ? 'none' : summary.missed ? 'bad' : summary.close ? 'watch' : 'good';
    const parts = [`${summary.met} of ${item.kpis.length} met`];
    if (summary.close) parts.push(`${summary.close} close`);
    if (summary.missed) parts.push(`${summary.missed} missed`);
    if (summary.pending) parts.push(`${summary.pending} awaiting validation`);
    if (summary.no_data) parts.push(`${summary.no_data} not reported`);
    if (item.in_progress) parts.push('in progress, judged on pace');
    item.detail = parts.join(' · ');
    delete item.reported;
    items.push(item);
  }
  return items;
}

/**
 * Feed for a date range: events overlapping [from, to] plus derived items —
 * past days that have numbers but are not closed yet ("Close PATS day"), task and
 * milestone due dates, and results against the goals set for each KPI.
 */
export async function calendarFeed(client, membership, { from, to }) {
  const today = todayIn(membership.workspace_timezone);
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(today, -today.slice(8, 10) + 1);
  const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : addDays(start, 41);
  if (end < start) return err('invalid', '"to" must not be before "from".');
  if ((new Date(end) - new Date(start)) / 86400000 > 92) return err('invalid', 'Ask for at most three months at a time.');
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';

  const { rows: events } = await client.query(
    `${EVENT_SELECT}
     WHERE e.starts_at < (($2::date + 1)::timestamp AT TIME ZONE $3) AND e.ends_at >= ($1::date::timestamp AT TIME ZONE $3)
     GROUP BY e.id, o.short_name, e.created_by
     ORDER BY e.starts_at`,
    [start, end, tz],
  );
  const { rows: unlocked } = await client.query(
    `SELECT s.org_id, o.short_name AS org, o.slug, s.period_date, count(*)::int AS numbers
     FROM submissions s
     JOIN organisations o ON o.id = s.org_id
     LEFT JOIN org_periods p ON p.org_id = s.org_id AND p.period_date = s.period_date
     WHERE s.period_date BETWEEN $1 AND LEAST($2::date, $3::date)
       AND COALESCE(p.status, 'open') = 'open'
     GROUP BY s.org_id, o.short_name, o.slug, s.period_date
     ORDER BY s.period_date, o.short_name`,
    [start, end, today],
  );

  const { rows: taskDues } = await client.query(
    `SELECT t.id, t.title, t.due_on, t.status, p.id AS project_id, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     WHERE t.due_on BETWEEN $1::date AND $2::date
       AND t.status NOT IN ('done', 'cancelled')`,
    [start, end],
  );

  const { rows: milestoneDues } = await client.query(
    `SELECT m.id, m.name, m.due_on, m.status, p.id AS project_id, p.name AS project_name
     FROM milestones m
     JOIN projects p ON p.id = m.project_id AND p.workspace_id = m.workspace_id
     WHERE m.due_on BETWEEN $1::date AND $2::date
       AND m.status = 'open'`,
    [start, end],
  );

  const targets = await targetItems(client, start, end, today);

  const items = [
    ...events.map((e) => ({ ...e, source: 'event', editable: mayEditEvent(membership, e) })),
    ...unlocked.map((u) => ({
      id: `lock:${u.org_id}:${u.period_date}`,
      source: 'lock',
      kind: 'deadline',
      title: `Close ${u.org} day`,
      org: u.org,
      org_slug: u.slug,
      date: u.period_date,
      all_day: true,
      detail: `${u.numbers} number${u.numbers === 1 ? '' : 's'} waiting · ${u.period_date < today ? 'overdue' : 'due today'}`,
      editable: false,
    })),
    ...taskDues.map((t) => ({
      id: `task:${t.id}`,
      source: 'task',
      kind: 'deadline',
      title: t.title,
      date: t.due_on,
      project_id: t.project_id,
      project_name: t.project_name,
      all_day: true,
      detail: `Task · ${t.project_name}${t.due_on < today ? ' · overdue' : ''}`,
      editable: false,
      link: '/my-work',
    })),
    ...milestoneDues.map((m) => ({
      id: `milestone:${m.id}`,
      source: 'milestone',
      kind: 'deadline',
      title: m.name,
      date: m.due_on,
      project_id: m.project_id,
      project_name: m.project_name,
      all_day: true,
      detail: `Milestone · ${m.project_name}`,
      editable: false,
      link: '/projects',
    })),
    ...targets,
  ];
  return { from: start, to: end, timezone: tz, today, items };
}

/* ICS export --------------------------------------------------------------------------------- */
export function icsToken(membership) {
  return jwt.sign({ kind: 'ics', membership_id: membership.id, workspace_id: membership.workspace_id }, config.jwtSecret, { expiresIn: '365d' });
}
export function verifyIcsToken(token) {
  const payload = jwt.verify(String(token ?? ''), config.jwtSecret);
  if (payload.kind !== 'ics') throw new Error('not a calendar token');
  return payload;
}
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
export function toIcs(feed, workspaceName) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PortfolioOS//Calendar//EN', `X-WR-CALNAME:${icsText(workspaceName ?? 'PortfolioOS')}`];
  for (const e of feed.items.filter((i) => i.source === 'event')) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@portfolioos`, `DTSTAMP:${icsDate(new Date())}`);
    if (e.all_day) {
      const d = (x) => new Date(x).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d(e.starts_at)}`, `DTEND;VALUE=DATE:${d(new Date(new Date(e.ends_at).getTime() + 86400000))}`);
    } else {
      lines.push(`DTSTART:${icsDate(e.starts_at)}`, `DTEND:${icsDate(e.ends_at)}`);
    }
    lines.push(`SUMMARY:${icsText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* Reminder job: WhatsApp to the creator and participants who have a phone on file. */
registerJob('event_reminder', async (client, payload) => {
  const event = await loadEvent(client, payload.event_id);
  if (!event) return; // deleted since
  const { rows } = await client.query(
    `SELECT DISTINCT u.phone_e164 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE (m.id = $1 OR m.id IN (SELECT membership_id FROM calendar_event_participants WHERE event_id = $2 AND response <> 'no'))
       AND u.phone_e164 IS NOT NULL AND u.phone_e164 <> ''`,
    [event.created_by, event.id],
  );
  const when = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(event.starts_at));
  const body = `Reminder: ${event.title} at ${when}${event.location ? ` · ${event.location}` : ''}`;
  for (const r of rows) {
    await client.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1, $2, 'reminder')`, [r.phone_e164, body]);
  }
  if (rows.length) {
    const { rows: wsRow } = await client.query(`SELECT id, timezone FROM workspaces WHERE id = app_workspace()`);
    if (wsRow[0]) await noteWaMessage(wsRow[0].id, wsRow[0].timezone);
  }
});
