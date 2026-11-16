/*
 * Attendance: explicit clock in / clock out (web button, or "@ in" / "@ out" on WhatsApp via the
 * clock_in / clock_out agent tools), and sign-in events for the Sign-ins report.
 */
import { query } from '../db.js';
import { todayIn } from '../core/dates.js';

const err = (code, message) => ({ error: { code, message } });

async function todayEvents(client, membership) {
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const { rows } = await client.query(
    `SELECT kind, at, to_char(at AT TIME ZONE $2, 'HH24:MI') AS hm
     FROM attendance_events
     WHERE membership_id = $1 AND (at AT TIME ZONE $2)::date = $3::date
     ORDER BY at`,
    [membership.id, tz, todayIn(tz)],
  );
  return rows;
}

function summarise(events) {
  let ms = 0;
  let openAt = null;
  for (const e of events) {
    if (e.kind === 'in' && !openAt) openAt = new Date(e.at);
    if (e.kind === 'out' && openAt) {
      ms += new Date(e.at) - openAt;
      openAt = null;
    }
  }
  if (openAt) ms += Date.now() - openAt;
  const last = events[events.length - 1];
  return {
    state: !last ? 'none' : last.kind === 'in' ? 'in' : 'out',
    since: last?.hm ?? null,
    first_in: events.find((e) => e.kind === 'in')?.hm ?? null,
    hours_today: Math.round((ms / 3600000) * 10) / 10,
    events: events.map((e) => ({ kind: e.kind, time: e.hm })),
  };
}

export async function attendanceStatus(client, membership) {
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  return { today: todayIn(tz), ...summarise(await todayEvents(client, membership)) };
}

/**
 * Clock in or out. `kind` omitted = toggle.
 * @param {{ kind?: 'in'|'out', note?: string }} body
 */
export async function clock(client, membership, body = {}, source = 'web') {
  const events = await todayEvents(client, membership);
  const now = summarise(events);
  const kind = body.kind === 'in' || body.kind === 'out' ? body.kind : now.state === 'in' ? 'out' : 'in';
  if (kind === 'in' && now.state === 'in') return err('conflict', `You are already clocked in (since ${now.since}).`);
  if (kind === 'out' && now.state !== 'in') return err('conflict', 'You are not clocked in today.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) || null : null;
  await client.query(`INSERT INTO attendance_events (membership_id, kind, source, note) VALUES ($1, $2, $3, $4)`, [
    membership.id,
    kind,
    source,
    note,
  ]);
  return { ok: true, kind, ...(await attendanceStatus(client, membership)) };
}

/** Sign-in / sign-out record. Never blocks or fails the sign-in itself. */
export async function recordAuthEvent(membershipId, kind, { channel = 'web', userAgent = null } = {}) {
  try {
    await query(`SELECT auth.record_auth_event($1, $2, $3, $4)`, [membershipId, kind, channel, userAgent]);
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.warn('[auth_events]', e.message);
  }
}
