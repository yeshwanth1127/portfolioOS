import { cancelQueued, enqueue, registerJob } from '../../jobs/queue.js';

/*
 * Meeting invites (docs/MEETINGS.md): the people a meeting is with get an in-app notification
 * that links to it, so they can join from the bell. Notifications for other people can only be
 * written in the system scope (RLS policy `mine` on notifications), so these go through a job,
 * which also means they exist only if the meeting change commits.
 *
 *   invited   — scheduled meeting:   "Asha invited you to Weekly review · Tue 18 Nov, 3:00 pm"
 *   started   — instant / live:      "Asha started a meeting with you: Weekly review"  (Join)
 *   reminder  — 10 minutes before:   "Weekly review starts in 10 minutes"               (Join)
 *   cancelled — scheduled, cancelled: "Asha cancelled Weekly review (Tue 18 Nov, 3:00 pm)"
 */
const REMINDER_MINUTES = 10;
const KINDS = new Set(['invited', 'started', 'reminder', 'cancelled']);

/** Queue in-app notifications for `membershipIds` about a meeting (in the caller's transaction). */
export async function notifyMeeting(client, meetingId, membershipIds, kind, extra = {}) {
  const ids = [...new Set(membershipIds ?? [])];
  if (!ids.length || !KINDS.has(kind)) return;
  await enqueue(client, 'meeting_notify', { meeting_id: meetingId, kind, membership_ids: ids, ...extra });
}

export async function scheduleMeetingReminder(client, meetingId, startsAt) {
  const at = new Date(new Date(startsAt).getTime() - REMINDER_MINUTES * 60000);
  if (at <= new Date()) return;
  await enqueue(client, 'meeting_notify', { meeting_id: meetingId, kind: 'reminder' }, {
    runAt: at,
    dedupeKey: `meeting:${meetingId}:reminder`,
  });
}

export async function cancelMeetingReminders(client, meetingId) {
  await cancelQueued(client, `meeting:${meetingId}:`);
}

function formatWhen(at, timeZone) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone,
  }).format(new Date(at));
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

/** Body and link for one notification; exported for tests. */
export function meetingNotice(kind, { title, startsAt, hostName, meetingId, timeZone }) {
  const when = startsAt ? formatWhen(startsAt, timeZone) : '';
  const who = firstName(hostName);
  switch (kind) {
    case 'started':
      return { body: `${who} started a meeting with you: ${title}. Join now.`, link: `/meetings/${meetingId}?join=1` };
    case 'reminder':
      return { body: `${title} starts in ${REMINDER_MINUTES} minutes.`, link: `/meetings/${meetingId}` };
    case 'cancelled':
      return { body: `${who} cancelled ${title} (${when}).`, link: null };
    default:
      return { body: `${who} invited you to ${title} · ${when}.`, link: `/meetings/${meetingId}` };
  }
}

registerJob('meeting_notify', async (client, payload) => {
  const { meeting_id: meetingId, kind } = payload ?? {};
  if (!meetingId || !KINDS.has(kind)) return;
  const { rows: ws } = await client.query(`SELECT timezone FROM workspaces WHERE id = app_workspace()`);
  const timeZone = ws[0]?.timezone || 'Asia/Kolkata';

  let meeting = null;
  if (kind !== 'cancelled') {
    const { rows } = await client.query(
      `SELECT id, title, starts_at, status, host_membership_id, auth.workspace_member_name(host_membership_id) AS host_name
       FROM meetings WHERE id = $1`,
      [meetingId],
    );
    meeting = rows[0];
    if (!meeting) return; // cancelled since
    if (kind === 'reminder' && meeting.status !== 'scheduled') return; // already started or over
    if (kind === 'invited' && meeting.status === 'ended') return;
  }

  let recipients = payload.membership_ids;
  if (kind === 'reminder') {
    // Everyone invited at reminder time, including people added after scheduling, and the host.
    const { rows } = await client.query(`SELECT membership_id FROM meeting_participants WHERE meeting_id = $1 AND invited`, [meetingId]);
    recipients = rows.map((r) => r.membership_id);
  }
  if (!recipients?.length) return;

  let hostName = meeting?.host_name;
  if (kind === 'cancelled' && payload.by) {
    const { rows } = await client.query(`SELECT auth.workspace_member_name($1) AS name`, [payload.by]);
    hostName = rows[0]?.name;
  }
  const { body, link } = meetingNotice(kind, {
    title: meeting?.title ?? payload.title ?? 'A meeting',
    startsAt: meeting?.starts_at ?? payload.starts_at,
    hostName,
    meetingId,
    timeZone,
  });
  await client.query(
    `INSERT INTO notifications (membership_id, kind, meeting_id, link, body, channel)
     SELECT m.id, $2, $3, $4, $5, 'in_app'
     FROM memberships m
     WHERE m.id = ANY($1::uuid[]) AND m.state <> 'inactive'`,
    [recipients, `meeting_${kind}`, kind === 'cancelled' ? null : meetingId, link, body.slice(0, 500)],
  );
});
