import crypto from 'node:crypto';
import { query, withSession } from '../../db.js';
import { can } from '../../core/permissions/can.js';
import { permissionDenied } from '../../core/permissions/permission-denied.js';
import { createEvent, deleteEvent, updateEvent } from '../calendar.js';
import { createTask } from '../projects.js';
import { deleteRoom, joinToken, livekitConfig, livekitConfigured } from './livekit.js';
import { queueSummary } from './assistant.js';
import { notifyMeeting, cancelMeetingReminders, scheduleMeetingReminder } from './invites.js';

/*
 * Meetings (docs/MEETINGS.md): video meetings for the people of a workspace, on our own LiveKit
 * server. Visibility is RLS (026_meetings.sql), the same as calendar events: the owner sees all;
 * others see their organisation's meetings, meetings they host, and meetings they're invited to.
 * Only people who can see a meeting can get a token to join it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });
const MAX_MINUTES = 12 * 60;

const onlyHost = () => err('forbidden', 'Only the person who started this meeting can end or cancel it.');

const systemActor = (workspaceId) => ({
  id: '00000000-0000-0000-0000-000000000000',
  role: 'system',
  org_id: null,
  workspace_id: workspaceId,
});

const MEETING_SELECT = `
  SELECT m.id, m.title, m.description, m.status, m.starts_at, m.ends_at, m.started_at, m.ended_at,
         m.org_id, o.short_name AS org, m.host_membership_id,
         auth.workspace_member_name(m.host_membership_id) AS host_name,
         m.calendar_event_id, m.qlix_enabled, m.room_name, m.created_at, m.summary_status, m.summary_error,
         COALESCE(json_agg(json_build_object(
             'membership_id', p.membership_id,
             'name', auth.workspace_member_name(p.membership_id),
             'role', p.role, 'invited', p.invited, 'joined_at', p.joined_at, 'left_at', p.left_at)
           ORDER BY p.role DESC, auth.workspace_member_name(p.membership_id))
           FILTER (WHERE p.membership_id IS NOT NULL), '[]') AS participants
  FROM meetings m
  LEFT JOIN organisations o ON o.id = m.org_id
  LEFT JOIN meeting_participants p ON p.meeting_id = m.id`;
const MEETING_GROUP = `GROUP BY m.id, o.short_name`;

function present(row, membership) {
  if (!row) return null;
  const { room_name: _room, ...m } = row;
  return {
    ...m,
    can_manage: mayManage(membership, row),
    // Ending (or cancelling) is for the person who started the meeting, and no one else.
    can_end: row.host_membership_id === membership.id,
    in_call: m.participants.filter((p) => p.joined_at && (!p.left_at || new Date(p.left_at) < new Date(p.joined_at))).length,
  };
}

function mayManage(membership, meeting) {
  return can(membership, 'meeting.manage', {
    isHost: meeting.host_membership_id === membership.id,
    meetingOrgId: meeting.org_id ?? null,
  });
}

async function loadMeeting(client, id, { lock = false } = {}) {
  if (!UUID.test(String(id ?? ''))) return null;
  if (lock) {
    const { rows } = await client.query(`SELECT id FROM meetings WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) return null;
  }
  const { rows } = await client.query(`${MEETING_SELECT} WHERE m.id = $1 ${MEETING_GROUP}`, [id]);
  return rows[0] ?? null;
}

function parseInstant(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Validate a new meeting. Returns { value } or { error }. */
function readMeeting(body) {
  const b = body ?? {};
  const title = String(b.title ?? '').trim() || (b.instant ? 'Instant meeting' : '');
  if (!title) return err('invalid', 'Give the meeting a title.');
  if (title.length > 200) return err('invalid', 'Keep the title under 200 characters.');
  const instant = Boolean(b.instant);
  const start = instant ? new Date() : parseInstant(b.starts_at);
  if (!start) return err('invalid', 'Pick when the meeting starts.');
  const minutes = b.duration_minutes == null ? 60 : Number(b.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_MINUTES) {
    return err('invalid', 'A meeting can last between 5 minutes and 12 hours.');
  }
  if (!instant && start < new Date(Date.now() - 24 * 3600000)) return err('invalid', 'That start time has already passed.');
  if (b.org_id && !UUID.test(String(b.org_id))) return err('invalid', 'Unknown organisation.');
  const who = readInvitees(b);
  if (who.error) return who;
  if (!who.value.participant_ids.length && !who.value.team_ids.length && !who.value.org_ids.length) {
    return err('invalid', 'Choose who the meeting is with: people, a team or an organisation.');
  }
  const description = b.description ? String(b.description).trim().slice(0, 4000) : null;
  return {
    value: {
      title,
      description,
      instant,
      starts_at: start,
      ends_at: new Date(start.getTime() + minutes * 60000),
      org_id: b.org_id || null,
      ...who.value,
      qlix_enabled: b.qlix_enabled === undefined ? true : Boolean(b.qlix_enabled),
    },
  };
}

const MAX_INVITEES = 300;

/** `participant_ids`, `team_ids` (units: a team, department or branch) and `org_ids`. */
function readInvitees(b) {
  const out = {};
  for (const key of ['participant_ids', 'team_ids', 'org_ids']) {
    const ids = b?.[key] == null ? [] : b[key];
    if (!Array.isArray(ids) || ids.some((id) => !UUID.test(String(id)))) {
      return err('invalid', key === 'participant_ids' ? 'Unknown person.' : key === 'team_ids' ? 'Unknown team.' : 'Unknown organisation.');
    }
    out[key] = [...new Set(ids.map(String))].slice(0, 200);
  }
  return { value: out };
}

/**
 * Expand people + teams + organisations into membership ids. Invites are workspace-wide: anyone
 * can meet anyone in the workspace (auth.meeting_directory, 030_meeting_directory.sql). A team
 * means everyone assigned to it or to a unit under it.
 */
async function resolveInvitees(client, membership, { participant_ids, team_ids, org_ids }) {
  const check = async (sql, ids, message) => {
    if (!ids.length) return null;
    const { rows } = await client.query(sql, [ids]);
    return rows[0].n === ids.length ? null : err('invalid', message);
  };
  const bad =
    (await check(`SELECT count(*)::int AS n FROM auth.meeting_directory() WHERE id = ANY($1::uuid[])`, participant_ids, 'Some people could not be found.'))
    ?? (await check(`SELECT count(*)::int AS n FROM auth.meeting_units() WHERE id = ANY($1::uuid[])`, team_ids, 'Some teams could not be found.'))
    ?? (await check(`SELECT count(*)::int AS n FROM auth.meeting_orgs() WHERE id = ANY($1::uuid[])`, org_ids, 'Some organisations could not be found.'));
  if (bad) return bad;
  const { rows } = await client.query(
    `WITH RECURSIVE units AS (SELECT * FROM auth.meeting_units()),
     picked AS (
       SELECT id FROM units WHERE id = ANY($2::uuid[])
       UNION
       SELECT u.id FROM units u JOIN picked p ON u.parent_id = p.id
     )
     SELECT d.id
     FROM auth.meeting_directory() d
     WHERE d.id <> $4
       AND (d.id = ANY($1::uuid[]) OR d.org_id = ANY($3::uuid[]) OR d.unit_ids && ARRAY(SELECT id FROM picked))`,
    [participant_ids, team_ids, org_ids, membership.id],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length > MAX_INVITEES) return err('invalid', `A meeting can have up to ${MAX_INVITEES} people. Pick a smaller group.`);
  if (!ids.length) return err('invalid', 'No one else is in that group yet. Pick other people.');
  return { ids };
}

/**
 * Who the caller can invite: everyone in the workspace, every team and every organisation
 * (whatever organisation is picked in the sidebar, and whatever the caller's role). Powers the
 * "Who is this meeting with?" picker.
 */
export async function listInvitees(client, membership) {
  const { rows: everyone } = await client.query(
    `SELECT d.id, d.full_name, d.title, d.role, d.org_id, o.short_name AS org, d.unit_ids
     FROM auth.meeting_directory() d
     LEFT JOIN auth.meeting_orgs() o ON o.id = d.org_id
     ORDER BY d.full_name`,
  );
  const people = everyone.filter((p) => p.id !== membership.id);
  const { rows: units } = await client.query(`SELECT * FROM auth.meeting_units() ORDER BY lower(name)`);
  const { rows: orgs } = await client.query(`SELECT * FROM auth.meeting_orgs() ORDER BY lower(name)`);

  // Every organisation is listed, even one with no one else in it (shown, but not pickable).
  // Team → everyone in it or in a unit under it.
  const byId = new Map(units.map((u) => [u.id, u]));
  const orgOf = (u) => {
    for (let cur = u, i = 0; cur && i < 20; cur = byId.get(cur.parent_id), i += 1) {
      if (cur.type === 'organisation') return cur.legacy_org_id;
    }
    return null;
  };
  const ancestors = (unitId) => {
    const out = [];
    for (let cur = byId.get(unitId), i = 0; cur && i < 20; cur = byId.get(cur.parent_id), i += 1) out.push(cur.id);
    return out;
  };
  const members = new Map();
  for (const p of people) {
    for (const uid of p.unit_ids) {
      for (const a of ancestors(uid)) {
        if (!members.has(a)) members.set(a, new Set());
        members.get(a).add(p.id);
      }
    }
  }
  const orgName = new Map(orgs.map((o) => [o.id, o.short_name || o.name]));
  const teams = units
    .filter((u) => u.type !== 'organisation' && members.get(u.id)?.size)
    .map((u) => ({
      id: u.id,
      name: u.name,
      type: u.type,
      org_id: orgOf(u),
      org: orgName.get(orgOf(u)) ?? null,
      member_ids: [...members.get(u.id)],
    }));
  const orgList = orgs
    .map((o) => ({ id: o.id, name: o.name, short_name: o.short_name, member_ids: people.filter((p) => p.org_id === o.id).map((p) => p.id) }));
  return {
    people: people.map(({ unit_ids: _u, ...p }) => p),
    teams,
    orgs: orgList,
  };
}

export async function listMeetings(client, membership) {
  const { rows } = await client.query(
    `${MEETING_SELECT}
     WHERE m.status = 'live' OR m.starts_at > now() - interval '90 days'
     ${MEETING_GROUP}
     ORDER BY m.starts_at DESC
     LIMIT 300`,
  );
  return { meetings: rows.map((r) => present(r, membership)), available: livekitConfigured() };
}

export async function getMeeting(client, membership, id) {
  const m = await loadMeeting(client, id);
  if (!m) return err('not_found', 'Meeting not found');
  const { rows } = await client.query(
    `SELECT summary, decisions, action_items, created_at, updated_at FROM meeting_summaries WHERE meeting_id = $1`,
    [id],
  );
  const { rows: count } = await client.query(`SELECT count(*)::int AS n FROM meeting_transcript_segments WHERE meeting_id = $1`, [id]);
  return {
    meeting: { ...present(m, membership), transcript_lines: count[0].n },
    summary: rows[0] ?? null,
    available: livekitConfigured(),
  };
}

/** Host / manager: write (or rewrite) the Meeting Assistant summary now. */
export async function requestSummary(client, membership, id) {
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (!mayManage(membership, m)) return permissionDenied(membership, 'meeting.manage');
  if (m.status !== 'ended') return err('conflict', 'The summary is written after the meeting ends.');
  if (!m.qlix_enabled) {
    await client.query(`UPDATE meetings SET qlix_enabled = true WHERE id = $1`, [id]);
  }
  if (['pending', 'running'].includes(m.summary_status)) return { meeting: present(await loadMeeting(client, id), membership) };
  await queueSummary(client, id, { force: true });
  return { meeting: present(await loadMeeting(client, id), membership) };
}

export async function createMeeting(client, membership, body) {
  if (!can(membership, 'meeting.create')) return permissionDenied(membership, 'meeting.create');
  const parsed = readMeeting(body);
  if (parsed.error) return parsed;
  const v = parsed.value;
  if (membership.role !== 'owner' && v.org_id && v.org_id !== membership.org_id) {
    return err('forbidden', 'You can only create meetings for your own organisation.');
  }
  // A meeting for one whole organisation belongs to it (everyone there can see it); otherwise
  // it belongs to the host's organisation and invitees elsewhere see it because they're invited.
  const orgId = v.org_id
    ?? (membership.role === 'owner' ? (v.org_ids.length === 1 && !v.participant_ids.length && !v.team_ids.length ? v.org_ids[0] : null) : membership.org_id);
  const resolved = await resolveInvitees(client, membership, v);
  if (resolved.error) return resolved;
  const invitees = resolved.ids;

  const id = crypto.randomUUID();
  // Scheduled meetings go on the calendar (invitees see them and get reminders).
  let eventId = null;
  if (!v.instant) {
    const created = await createEvent(client, membership, {
      title: v.title,
      kind: 'meeting',
      starts_at: v.starts_at.toISOString(),
      ends_at: v.ends_at.toISOString(),
      description: v.description,
      location: `/meetings/${id}`,
      org_id: orgId,
      participant_ids: invitees,
      reminder_minutes: [10],
    });
    if (created.error) return created;
    eventId = created.event.id;
  }

  await client.query(
    `INSERT INTO meetings (id, workspace_id, org_id, calendar_event_id, title, description, host_membership_id,
                           room_name, status, starts_at, ends_at, qlix_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9, $10, $11)`,
    [id, membership.workspace_id, orgId, eventId, v.title, v.description, membership.id, `orbit-${id}`, v.starts_at, v.ends_at, v.qlix_enabled],
  );
  await client.query(
    `INSERT INTO meeting_participants (meeting_id, membership_id, role, invited) VALUES ($1, $2, 'host', true)`,
    [id, membership.id],
  );
  for (const pid of invitees) {
    await client.query(
      `INSERT INTO meeting_participants (meeting_id, membership_id, role, invited) VALUES ($1, $2, 'attendee', true)
       ON CONFLICT DO NOTHING`,
      [id, pid],
    );
  }
  await notifyMeeting(client, id, invitees, v.instant ? 'started' : 'invited');
  if (!v.instant) await scheduleMeetingReminder(client, id, v.starts_at);
  return { meeting: present(await loadMeeting(client, id), membership), invited: invitees.length };
}

/**
 * Host / manager: invite more people (or a team / organisation) to a meeting that hasn't
 * ended. They're added to the calendar event too, and each gets an in-app notification.
 */
export async function addParticipants(client, membership, id, body) {
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (!mayManage(membership, m)) return permissionDenied(membership, 'meeting.manage');
  if (m.status === 'ended') return err('conflict', 'This meeting has ended.');
  const who = readInvitees(body);
  if (who.error) return who;
  if (!who.value.participant_ids.length && !who.value.team_ids.length && !who.value.org_ids.length) {
    return err('invalid', 'Choose who to invite.');
  }
  const resolved = await resolveInvitees(client, membership, who.value);
  if (resolved.error) return resolved;
  const already = new Set(m.participants.filter((p) => p.invited).map((p) => p.membership_id));
  const fresh = resolved.ids.filter((pid) => !already.has(pid));
  if (m.participants.length + fresh.length > MAX_INVITEES + 1) {
    return err('invalid', `A meeting can have up to ${MAX_INVITEES} people.`);
  }
  for (const pid of fresh) {
    await client.query(
      `INSERT INTO meeting_participants (meeting_id, membership_id, role, invited) VALUES ($1, $2, 'attendee', true)
       ON CONFLICT (meeting_id, membership_id) DO UPDATE SET invited = true`,
      [id, pid],
    );
  }
  if (fresh.length && m.calendar_event_id) {
    const all = [...new Set([...already, ...fresh])].filter((pid) => pid !== m.host_membership_id);
    const updated = await updateEvent(client, membership, m.calendar_event_id, { participant_ids: all });
    // The calendar is a convenience; the invite itself stands even if the event can't be edited.
    if (updated.error && !['forbidden', 'not_found'].includes(updated.error.code)) return updated;
  }
  if (fresh.length) await notifyMeeting(client, id, fresh, m.status === 'live' ? 'started' : 'invited');
  return { meeting: present(await loadMeeting(client, id), membership), invited: fresh.length };
}

/** Cancel a meeting that has not happened yet (and its calendar event). */
export async function deleteMeeting(client, membership, id) {
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (m.host_membership_id !== membership.id) return onlyHost();
  if (m.status !== 'scheduled') return err('conflict', 'Only a meeting that has not started can be cancelled.');
  const invited = m.participants.filter((p) => p.invited && p.membership_id !== membership.id).map((p) => p.membership_id);
  await notifyMeeting(client, id, invited, 'cancelled', { title: m.title, starts_at: m.starts_at, by: membership.id });
  await cancelMeetingReminders(client, id);
  await client.query(`DELETE FROM meetings WHERE id = $1`, [id]);
  if (m.calendar_event_id) {
    const removed = await deleteEvent(client, membership, m.calendar_event_id);
    // The host may not be allowed to edit an event someone else moved; the meeting is gone either way.
    if (removed.error && removed.error.code !== 'forbidden' && removed.error.code !== 'not_found') return removed;
  }
  return { ok: true };
}

/** A LiveKit token for the caller. Seeing the meeting (RLS) is what allows joining it. */
export async function issueJoinToken(client, membership, id) {
  const cfg = livekitConfig();
  if (!livekitConfigured(cfg)) return err('unavailable', 'Meetings are not set up on this server yet.');
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (m.status === 'ended') return err('conflict', 'This meeting has ended.');

  await client.query(
    `INSERT INTO meeting_participants (meeting_id, membership_id, role, invited, joined_at)
     VALUES ($1, $2, 'attendee', false, now())
     ON CONFLICT (meeting_id, membership_id) DO UPDATE SET joined_at = now()`,
    [id, membership.id],
  );
  if (m.status === 'scheduled') await client.query(`SELECT auth.start_meeting($1)`, [id]);
  const token = joinToken({
    room: m.room_name,
    identity: membership.id,
    name: membership.full_name || 'Guest',
    metadata: { membership_id: membership.id, role: m.host_membership_id === membership.id ? 'host' : 'attendee' },
  }, cfg);
  return { token, url: cfg.publicUrl, room: m.room_name, identity: membership.id, meeting_id: id, qlix_enabled: m.qlix_enabled };
}

/** End for everyone: mark ended, then close the LiveKit room (after the transaction commits). */
export async function endMeeting(client, membership, id) {
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (m.host_membership_id !== membership.id) return onlyHost();
  if (m.status !== 'ended') {
    await client.query(
      `UPDATE meetings SET status = 'ended', ended_at = now(), started_at = coalesce(started_at, now()), updated_at = now() WHERE id = $1`,
      [id],
    );
    await client.query(`UPDATE meeting_participants SET left_at = now() WHERE meeting_id = $1 AND joined_at IS NOT NULL AND (left_at IS NULL OR left_at < joined_at)`, [id]);
    await queueSummary(client, id);
  }
  return { meeting: present(await loadMeeting(client, id), membership), room: m.room_name };
}

export async function closeRoom(room) {
  if (!room || !livekitConfigured()) return;
  await deleteRoom(room).catch((e) => {
    if (process.env.NODE_ENV !== 'test') console.warn('[meetings] could not close room', room, e.message);
  });
}

/**
 * LiveKit webhook (already verified). Rooms are named orbit-<meeting id>; identities are
 * membership ids (anything else, e.g. the meeting bot, is ignored for attendance).
 */
export async function handleLivekitEvent(event) {
  const room = event?.room?.name;
  if (!room || !/^orbit-/.test(room)) return { ignored: true };
  const { rows } = await query(`SELECT * FROM auth.meeting_by_room($1)`, [room]);
  const found = rows[0];
  if (!found) return { ignored: true };
  const identity = event.participant?.identity;
  const person = UUID.test(String(identity ?? '')) ? identity : null;

  return withSession(systemActor(found.workspace_id), async (client) => {
    switch (event.event) {
      case 'room_started':
        await client.query(
          `UPDATE meetings SET status = 'live', started_at = coalesce(started_at, now()), updated_at = now()
           WHERE id = $1 AND status <> 'ended'`,
          [found.meeting_id],
        );
        break;
      case 'room_finished':
        await client.query(
          `UPDATE meetings SET status = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now() WHERE id = $1`,
          [found.meeting_id],
        );
        await client.query(
          `UPDATE meeting_participants SET left_at = now()
           WHERE meeting_id = $1 AND joined_at IS NOT NULL AND (left_at IS NULL OR left_at < joined_at)`,
          [found.meeting_id],
        );
        await queueSummary(client, found.meeting_id);
        break;
      case 'participant_joined':
      case 'participant_left': {
        if (!person) break;
        const { rows: member } = await client.query(`SELECT id FROM memberships WHERE id = $1`, [person]);
        if (!member[0]) break;
        const col = event.event === 'participant_joined' ? 'joined_at' : 'left_at';
        await client.query(
          `INSERT INTO meeting_participants (meeting_id, membership_id, role, invited, ${col})
           VALUES ($1, $2, 'attendee', false, now())
           ON CONFLICT (meeting_id, membership_id) DO UPDATE SET ${col} = now()`,
          [found.meeting_id, person],
        );
        break;
      }
      default:
        break;
    }
    return { ok: true };
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accept (→ a task in a project) or reject one action item the Meeting Assistant proposed.
 * The host / owner / org manager decides; the task is created as them, so the project's own
 * rules (who may add and assign tasks there) still apply.
 */
export async function decideActionItem(client, membership, id, index, body) {
  const m = await loadMeeting(client, id, { lock: true });
  if (!m) return err('not_found', 'Meeting not found');
  if (!mayManage(membership, m)) return permissionDenied(membership, 'meeting.manage');
  const i = Number(index);
  const { rows } = await client.query(`SELECT action_items FROM meeting_summaries WHERE meeting_id = $1`, [id]);
  const item = Number.isInteger(i) ? rows[0]?.action_items?.[i] : null;
  if (!item) return err('not_found', 'Action item not found');
  if (item.status !== 'proposed') return err('conflict', `This action item was already ${item.status}.`);

  const decision = body?.decision;
  if (decision === 'reject') {
    const { rows: out } = await client.query(`SELECT auth.set_meeting_action_item($1, $2, 'rejected', NULL) AS item`, [id, i]);
    return { action_item: out[0].item };
  }
  if (decision !== 'accept') return err('invalid', 'Decide accept or reject.');
  if (!UUID.test(String(body?.project_id ?? ''))) return err('invalid', 'Pick the project this task belongs to.');
  const assignee = body.assignee_id === undefined ? item.owner_membership_id ?? null : body.assignee_id || null;
  const due = body.due_on === undefined ? item.due_date ?? null : body.due_on || null;
  if (due && !ISO_DAY.test(String(due))) return err('invalid', 'Give the due date as YYYY-MM-DD.');
  const day = (m.started_at ?? m.starts_at).toISOString().slice(0, 10);
  const created = await createTask(client, membership, body.project_id, {
    title: String(body.title ?? item.text).trim().slice(0, 300),
    assignee_id: assignee,
    due_on: due,
    description: `From the meeting "${m.title}" on ${day} (/meetings/${id}).`,
  });
  if (created.error) return created;
  const { rows: out } = await client.query(`SELECT auth.set_meeting_action_item($1, $2, 'accepted', $3) AS item`, [
    id,
    i,
    created.task.id,
  ]);
  return { action_item: out[0].item, task: created.task };
}
