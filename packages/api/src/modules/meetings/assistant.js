/*
 * The Qlix Meeting Assistant (docs/MEETINGS.md).
 *
 * - The meeting bot (services/meeting-bot) joins the LiveKit room, turns each person's speech into
 *   text with Qlix's whisper-server, and posts it here (appendTranscript, service route).
 * - After the call, a job asks the workspace's "Meeting Assistant" Qlix agent, through the agent
 *   runner, to write the summary. The run token carries { profile: 'meeting', meeting_id } so the
 *   agent can read only that meeting, through two argument-free tools (meeting_context,
 *   meeting_transcript). Like report drafting, the agent replies in a fixed text format which
 *   this module parses and stores; no ADK changes are involved.
 */
import { loadMembership } from '../../auth.js';
import { config } from '../../core/config.js';
import { query, withSession } from '../../db.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { noteWaMessage } from '../commercial/usage.js';
import { createDispatch, listDispatches, livekitConfigured } from './livekit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });
const MEETING_AGENT_ID = 'portfolio-meeting-agent';
export const MEETING_BOT_NAME = process.env.MEETING_BOT_NAME || 'orbit-meeting-bot';
/** Transcript characters per agent turn; longer meetings are summarised part by part. */
export const PART_CHARS = Number(process.env.MEETING_PART_CHARS ?? 40000);
const AGENT_TIMEOUT_MS = Number(process.env.MEETING_AGENT_TIMEOUT_MS ?? 180000);
const SUMMARY_DELAY_MS = 15000; // let the bot flush its last segments

const systemActor = (workspaceId) => ({
  id: '00000000-0000-0000-0000-000000000000',
  role: 'system',
  org_id: null,
  workspace_id: workspaceId,
});
const asSystem = (workspaceId, fn) => withSession(systemActor(workspaceId), fn);

export const MEETING_PLAYBOOK = `You are this workspace's Meeting Assistant. You attend one meeting at a time.
Every tool is an action of the portfolio_os tool: call portfolio_os with action "meeting_context" or action "meeting_transcript" (no other fields). They are not tools of their own.
meeting_context gives the meeting's title, agenda, host and the people invited or present (use their names exactly).
meeting_transcript gives what was said, one line per utterance: [mm:ss] Speaker: words. Speech-to-text can mishear words; prefer the sense of the conversation over odd single words.
Only report what was actually said. Never invent decisions, owners, dates or numbers. Plain text only: no markdown, no JSON, no code fences.`;

// ---------------------------------------------------------------------------------------------
// Transcript

function mmss(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function transcriptLines(segments) {
  return segments.map((s) => `[${mmss(s.started_ms)}] ${s.speaker_name}: ${s.text}`);
}

/** Split transcript lines into parts of at most `max` characters (a line is never split). */
export function splitParts(lines, max = PART_CHARS) {
  const parts = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > max && cur.length) {
      parts.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

async function loadSegments(client, meetingId) {
  const { rows } = await client.query(
    `SELECT membership_id, speaker_name, started_ms, ended_ms, text FROM meeting_transcript_segments
     WHERE meeting_id = $1 ORDER BY started_ms, id`,
    [meetingId],
  );
  return rows;
}

/** Bot → API: store utterances for the meeting behind `room`. Runs as the system actor. */
export async function appendTranscript({ room, segments }) {
  if (!room || !Array.isArray(segments) || !segments.length) return err('invalid', 'room and segments are required');
  const { rows } = await query(`SELECT * FROM auth.meeting_by_room($1)`, [String(room)]);
  const found = rows[0];
  if (!found) return err('not_found', 'Meeting not found');
  const clean = segments.slice(0, 100).flatMap((s) => {
    const text = String(s?.text ?? '').trim().slice(0, 4000);
    const start = Math.max(0, Math.round(Number(s?.started_ms) || 0));
    const end = Math.max(start, Math.round(Number(s?.ended_ms) || start));
    if (!text) return [];
    return [{
      membership_id: UUID.test(String(s?.identity ?? '')) ? s.identity : null,
      speaker_name: String(s?.name || 'Someone').trim().slice(0, 200) || 'Someone',
      started_ms: start,
      ended_ms: end,
      text,
    }];
  });
  if (!clean.length) return { ok: true, stored: 0 };
  return asSystem(found.workspace_id, async (client) => {
    // Only real members of this workspace are linked; anyone else keeps just their name.
    const ids = [...new Set(clean.map((s) => s.membership_id).filter(Boolean))];
    const known = new Set();
    if (ids.length) {
      const { rows: m } = await client.query(`SELECT id FROM memberships WHERE id = ANY($1::uuid[])`, [ids]);
      m.forEach((r) => known.add(r.id));
    }
    for (const s of clean) {
      await client.query(
        `INSERT INTO meeting_transcript_segments (meeting_id, membership_id, speaker_name, started_ms, ended_ms, text)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [found.meeting_id, known.has(s.membership_id) ? s.membership_id : null, s.speaker_name, s.started_ms, s.ended_ms, s.text],
      );
    }
    return { ok: true, stored: clean.length };
  });
}

/** Anyone who can see the meeting can read its transcript. */
export async function getTranscript(client, _membership, id) {
  if (!UUID.test(String(id ?? ''))) return err('not_found', 'Meeting not found');
  const { rows } = await client.query(`SELECT id FROM meetings WHERE id = $1`, [id]);
  if (!rows[0]) return err('not_found', 'Meeting not found');
  return { segments: await loadSegments(client, id) };
}

// ---------------------------------------------------------------------------------------------
// Agent tools (meeting run tokens only)

function runMeeting(run) {
  if (run?.profile !== 'meeting' || !UUID.test(String(run?.meeting_id ?? ''))) return null;
  return run.meeting_id;
}

export async function meetingContextForAgent(client, membership, run) {
  const id = runMeeting(run);
  if (!id) return err('forbidden', 'meeting_context is only available to the Meeting Assistant.');
  const { rows } = await client.query(
    `SELECT m.title, m.description, m.status, m.starts_at, m.ends_at, m.started_at, m.ended_at,
            o.short_name AS org, auth.workspace_member_name(m.host_membership_id) AS host
     FROM meetings m LEFT JOIN organisations o ON o.id = m.org_id WHERE m.id = $1`,
    [id],
  );
  const m = rows[0];
  if (!m) return err('not_found', 'Meeting not found.');
  const { rows: people } = await client.query(
    `SELECT auth.workspace_member_name(p.membership_id) AS name, mb.title, p.role, p.invited, (p.joined_at IS NOT NULL) AS attended
     FROM meeting_participants p LEFT JOIN memberships mb ON mb.id = p.membership_id
     WHERE p.meeting_id = $1 ORDER BY p.role DESC, 1`,
    [id],
  );
  return {
    meeting: {
      title: m.title,
      agenda: m.description ?? null,
      organisation: m.org ?? null,
      host: m.host,
      status: m.status,
      scheduled_for: m.starts_at,
      started_at: m.started_at,
      ended_at: m.ended_at,
    },
    people: people.map((p) => ({ name: p.name, title: p.title ?? null, host: p.role === 'host', attended: p.attended })),
    asked_by: membership.full_name ?? null,
  };
}

export async function meetingTranscriptForAgent(client, _membership, run) {
  const id = runMeeting(run);
  if (!id) return err('forbidden', 'meeting_transcript is only available to the Meeting Assistant.');
  const { rows } = await client.query(`SELECT id FROM meetings WHERE id = $1`, [id]);
  if (!rows[0]) return err('not_found', 'Meeting not found.');
  const lines = transcriptLines(await loadSegments(client, id));
  if (!lines.length) return { transcript: '', lines: 0, note: 'Nothing has been said yet (or the Meeting Assistant could not hear anyone).' };
  const parts = splitParts(lines);
  if (Number.isInteger(run.transcript_part)) {
    const k = Math.min(Math.max(run.transcript_part, 0), parts.length - 1);
    return { part: k + 1, parts: parts.length, transcript: parts[k].join('\n') };
  }
  // Whole meeting when it fits; otherwise the most recent part (questions during the call).
  if (parts.length === 1) return { parts: 1, transcript: parts[0].join('\n') };
  return {
    part: parts.length,
    parts: parts.length,
    note: 'This is the most recent part of a long meeting.',
    transcript: parts[parts.length - 1].join('\n'),
  };
}

// ---------------------------------------------------------------------------------------------
// The summary

const NONE = /^(none|nothing|n\/a|-|no decisions?|no action items?)\.?$/i;

function section(text, name, next) {
  const re = new RegExp(`(?:^|\\n)\\s*${name}\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${next.join('|')})\\s*:|$)`, 'i');
  return (text.match(re)?.[1] ?? '').trim();
}

const bullets = (block) =>
  block
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\[-\]|[-*•]|\d+[.)])\s*/, '').trim()) // the runner turns "- " into "[-] "
    .filter((l) => l && !NONE.test(l));

/** Match a spoken/typed name to one of the meeting's people (exact, then unique first name). */
export function matchPerson(name, people) {
  const n = String(name ?? '').trim().toLowerCase().replace(/^(mr|ms|mrs|dr)\.?\s+/, '');
  if (!n || /^(unassigned|everyone|all|team|tbd|none)$/.test(n)) return null;
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^(mr|ms|mrs|dr)\.?\s+/, '');
  const exact = people.filter((p) => norm(p.name) === n);
  if (exact.length === 1) return exact[0];
  const first = n.split(/\s+/)[0];
  const byFirst = people.filter((p) => norm(p.name).split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Parse the agent's SUMMARY / DECISIONS / ACTION ITEMS reply. */
export function parseSummaryReply(reply, people = []) {
  const text = String(reply ?? '').replace(/\r\n/g, '\n').replace(/\*\*/g, '');
  const summary = section(text, 'SUMMARY', ['DECISIONS', 'ACTION ITEMS']).slice(0, 8000);
  const decisions = bullets(section(text, 'DECISIONS', ['ACTION ITEMS', 'SUMMARY'])).slice(0, 30).map((d) => d.slice(0, 500));
  const actionItems = bullets(section(text, 'ACTION ITEMS', ['DECISIONS', 'SUMMARY']))
    .slice(0, 40)
    .map((line) => {
      const [a, b, c] = line.split('|').map((x) => x.trim());
      const hasOwner = b !== undefined;
      const ownerName = hasOwner ? a : null;
      const task = (hasOwner ? b : a).slice(0, 500);
      const due = (c ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      const owner = ownerName ? matchPerson(ownerName, people) : null;
      return {
        text: task,
        owner_name: owner?.name ?? (ownerName && !/^unassigned$/i.test(ownerName) ? ownerName.slice(0, 200) : null),
        owner_membership_id: owner?.membership_id ?? null,
        due_date: due,
        status: 'proposed',
        task_id: null,
      };
    })
    .filter((a) => a.text);
  return { summary, decisions, action_items: actionItems };
}

/** Keep decided (accepted / rejected) items; add new proposals that aren't the same task again. */
export function mergeActionItems(previous, proposed) {
  const decided = (previous ?? []).filter((a) => a.status && a.status !== 'proposed');
  const key = (a) => String(a.text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set(decided.map(key));
  return [...decided, ...proposed.filter((a) => !seen.has(key(a)))].slice(0, 40);
}

const FORMAT = `Reply in exactly this format (plain text):
SUMMARY:
<3 to 6 sentences: what was discussed and where things landed>
DECISIONS:
- <one decision per line, or "- None">
ACTION ITEMS:
- <owner's name exactly as in meeting_context, or Unassigned> | <what they will do> | <due date as YYYY-MM-DD, or none>
(or "- None")`;

export function summaryMessage(meeting, { notes = null } = {}) {
  if (notes) {
    return `The meeting "${meeting.title}" has ended. It was long, so here are notes from each part of the transcript:\n\n${notes}\n\nRead meeting_context for the people, then write the summary for the people who attended.\n${FORMAT}`;
  }
  return `The meeting "${meeting.title}" has ended. Call portfolio_os with action "meeting_context", then with action "meeting_transcript", then write the summary for the people who attended.\n${FORMAT}`;
}

export function partMessage(meeting, k, n) {
  return `This is part ${k} of ${n} of the transcript of the meeting "${meeting.title}". Read it (portfolio_os with action "meeting_transcript") and reply with short plain-text notes: topics discussed, decisions made, and commitments (who will do what, by when). Notes only, no summary yet.`;
}

/** One Meeting Assistant turn through the agent runner. Always resolves: { reply, tools } or { unavailable }. */
async function askMeetingAgent({ membershipId, meetingId, message, part = null }) {
  const url = process.env.MEETINGS_RUNNER_URL ?? config.runnerUrl;
  if (!url) return { unavailable: 'agent runner not configured' };
  if (process.env.NODE_ENV === 'test' && !process.env.MEETINGS_RUNNER_URL) return { unavailable: 'test mode' };
  try {
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'x-service-secret': config.runnerSecret },
      body: JSON.stringify({
        membership_id: membershipId,
        agent_id: MEETING_AGENT_ID,
        message,
        history: [],
        channel: 'meeting',
        profile: 'meeting',
        meeting_id: meetingId,
        ...(part != null ? { transcript_part: part } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { unavailable: data.error?.message ?? data.error ?? data.code ?? `runner returned ${res.status}` };
    if (typeof data.reply !== 'string' || !data.reply.trim()) return { unavailable: 'no reply from the Meeting Assistant' };
    return { reply: data.reply, tools: data.tools ?? [], runId: data.qlix_run_id ?? null };
  } catch (e) {
    return { unavailable: e?.name === 'TimeoutError' ? 'the Meeting Assistant timed out' : `agent runner unreachable (${e?.message ?? e})` };
  }
}

const usedTool = (turn, action) => (turn.tools ?? []).some((t) => t?.action === action);

async function setSummaryState(workspaceId, meetingId, status, error = null) {
  await asSystem(workspaceId, (c) =>
    c.query(`UPDATE meetings SET summary_status = $2, summary_error = $3, updated_at = now() WHERE id = $1`, [
      meetingId,
      status,
      error ? String(error).slice(0, 500) : null,
    ]),
  );
}

const running = new Set();

/** Write the summary for one ended meeting. Never throws; the outcome is on the meeting row. */
export async function runMeetingSummary(meetingId, workspaceId) {
  if (running.has(meetingId)) return;
  running.add(meetingId);
  try {
    const prepared = await asSystem(workspaceId, async (c) => {
      const { rows } = await c.query(`SELECT id, title, host_membership_id, qlix_enabled FROM meetings WHERE id = $1`, [meetingId]);
      if (!rows[0]) return null;
      const segments = await loadSegments(c, meetingId);
      const { rows: people } = await c.query(
        `SELECT membership_id, auth.workspace_member_name(membership_id) AS name, (joined_at IS NOT NULL) AS attended
         FROM meeting_participants WHERE meeting_id = $1`,
        [meetingId],
      );
      return { meeting: rows[0], segments, people };
    });
    if (!prepared) return;
    const { meeting, segments, people } = prepared;
    if (!segments.length) return setSummaryState(workspaceId, meetingId, 'empty');
    await setSummaryState(workspaceId, meetingId, 'running');

    const host = await loadMembership(meeting.host_membership_id);
    if (!host) return setSummaryState(workspaceId, meetingId, 'failed', 'The host is no longer in this workspace.');

    const parts = splitParts(transcriptLines(segments));
    let turn;
    if (parts.length === 1) {
      // One retry: a model occasionally mis-calls a tool, and a second turn usually gets it right.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        turn = await askMeetingAgent({ membershipId: host.id, meetingId, message: summaryMessage(meeting) });
        if (turn.reply && !usedTool(turn, 'meeting_transcript')) turn = { unavailable: 'the Meeting Assistant did not read the transcript' };
        if (turn.reply || /not connected|disconnected|waiting/i.test(turn.unavailable ?? '')) break;
      }
    } else {
      const notes = [];
      for (let k = 0; k < parts.length; k += 1) {
        const t = await askMeetingAgent({ membershipId: host.id, meetingId, message: partMessage(meeting, k + 1, parts.length), part: k });
        if (!t.reply) {
          turn = t;
          break;
        }
        notes.push(`Part ${k + 1}:\n${t.reply.trim()}`);
      }
      if (!turn) turn = await askMeetingAgent({ membershipId: host.id, meetingId, message: summaryMessage(meeting, { notes: notes.join('\n\n') }) });
    }
    if (!turn.reply) return setSummaryState(workspaceId, meetingId, 'failed', turn.unavailable);

    const parsed = parseSummaryReply(turn.reply, people);
    if (!parsed.summary) return setSummaryState(workspaceId, meetingId, 'failed', 'The Meeting Assistant replied in an unexpected format.');

    await asSystem(workspaceId, async (c) => {
      // A rewrite keeps items people already accepted (tasks exist) or dismissed.
      const { rows: prev } = await c.query(`SELECT action_items FROM meeting_summaries WHERE meeting_id = $1`, [meetingId]);
      parsed.action_items = mergeActionItems(prev[0]?.action_items ?? [], parsed.action_items);
      await c.query(
        `INSERT INTO meeting_summaries (meeting_id, summary, decisions, action_items, qlix_run_id)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         ON CONFLICT (meeting_id) DO UPDATE SET summary = EXCLUDED.summary, decisions = EXCLUDED.decisions,
           action_items = EXCLUDED.action_items, qlix_run_id = EXCLUDED.qlix_run_id, updated_at = now()`,
        [meetingId, parsed.summary, JSON.stringify(parsed.decisions), JSON.stringify(parsed.action_items), turn.runId],
      );
      await c.query(`UPDATE meetings SET summary_status = 'ready', summary_error = NULL, updated_at = now() WHERE id = $1`, [meetingId]);
      const recipients = people.filter((x) => x.attended || x.membership_id === meeting.host_membership_id);
      for (const p of recipients) {
        await c.query(
          `INSERT INTO notifications (membership_id, kind, meeting_id, link, body, channel) VALUES ($1, 'meeting', $2, $3, $4, 'in_app')`,
          [p.membership_id, meetingId, `/meetings/${meetingId}`, `Meeting notes are ready: ${meeting.title}`.slice(0, 500)],
        );
      }
      await sendWhatsAppDigest(c, meeting, parsed, recipients);
    });
  } catch (e) {
    console.error('[meetings] summary failed', meetingId, e.message);
    await setSummaryState(workspaceId, meetingId, 'failed', 'Something went wrong while writing the summary.').catch(() => {});
  } finally {
    running.delete(meetingId);
  }
}

/** WhatsApp: a short digest to each attendee with a number, with their own action items. */
async function sendWhatsAppDigest(client, meeting, parsed, recipients) {
  if (process.env.MEETING_WHATSAPP_DIGEST === 'off' || !recipients.length) return;
  const { rows } = await client.query(
    `SELECT m.id, u.phone_e164 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.id = ANY($1::uuid[]) AND u.phone_e164 IS NOT NULL AND u.phone_e164 <> ''`,
    [recipients.map((r) => r.membership_id)],
  );
  if (!rows.length) return;
  const short = parsed.summary.length > 400 ? `${parsed.summary.slice(0, 397).trimEnd()}…` : parsed.summary;
  for (const r of rows) {
    const mine = parsed.action_items.filter((a) => a.owner_membership_id === r.id);
    const lines = [`Notes from "${meeting.title}"`, '', short];
    if (parsed.decisions.length) lines.push('', 'Decided:', ...parsed.decisions.slice(0, 5).map((d) => `• ${d}`));
    if (mine.length) lines.push('', 'Yours:', ...mine.map((a) => `• ${a.text}${a.due_date ? ` (by ${a.due_date})` : ''}`));
    await client.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1, $2, 'meeting')`, [r.phone_e164, lines.join('\n').slice(0, 1500)]);
  }
  const { rows: ws } = await client.query(`SELECT id, timezone FROM workspaces WHERE id = app_workspace()`);
  if (ws[0]) await noteWaMessage(ws[0].id, ws[0].timezone).catch(() => {});
}

/**
 * Queue the summary once a meeting has ended (host ended it, or LiveKit closed the empty room).
 * Only meetings with the assistant on, and only once unless `force` (the host asked again).
 */
export async function queueSummary(client, meetingId, { force = false } = {}) {
  const { rows } = await client.query(
    `UPDATE meetings SET summary_status = 'pending', summary_error = NULL, updated_at = now()
     WHERE id = $1 AND qlix_enabled AND status = 'ended'
       AND summary_status = ANY($2::text[])
     RETURNING workspace_id`,
    [meetingId, force ? ['none', 'failed', 'empty', 'ready'] : ['none']],
  );
  if (!rows[0]) return false;
  await enqueue(client, 'meeting_summarize', { meeting_id: meetingId }, {
    runAt: new Date(Date.now() + (force ? 0 : SUMMARY_DELAY_MS)),
    dedupeKey: `meeting_summary:${meetingId}:${Date.now()}`,
  });
  return true;
}

registerJob('meeting_summarize', async (_client, payload, job) => {
  // Detached: the summary opens its own short transactions around a slow agent call.
  setImmediate(() => runMeetingSummary(payload.meeting_id, job.workspace_id));
});

// ---------------------------------------------------------------------------------------------
// Bot dispatch

/** Ask LiveKit to send the meeting bot into the room, unless it is already on its way. */
export async function ensureBot({ room, meetingId }) {
  if (!room || !livekitConfigured() || process.env.MEETING_BOT === 'off') return { skipped: true };
  try {
    const existing = await listDispatches(room);
    if (existing.some((d) => d.agent_name === MEETING_BOT_NAME)) return { already: true };
    await createDispatch(room, MEETING_BOT_NAME, { meeting_id: meetingId });
    return { dispatched: true };
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.warn('[meetings] could not dispatch the meeting bot', room, e.message);
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------------------------
// Assistant tools (web chat, WhatsApp): what happened in meetings the caller can see.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function listMeetingsForAgent(client, membership, body = {}) {
  const tz = membership.workspace_timezone || 'Asia/Kolkata';
  const from = ISO_DAY.test(String(body.from ?? '')) ? body.from : null;
  const to = ISO_DAY.test(String(body.to ?? '')) ? body.to : null;
  const { rows } = await client.query(
    `SELECT m.title, m.status, m.summary_status, o.short_name AS org,
            coalesce(m.started_at, m.starts_at) AS at, m.ended_at,
            auth.workspace_member_name(m.host_membership_id) AS host,
            (SELECT count(*)::int FROM meeting_participants p WHERE p.meeting_id = m.id AND p.joined_at IS NOT NULL) AS attended,
            EXISTS (SELECT 1 FROM meeting_summaries s WHERE s.meeting_id = m.id) AS has_notes
     FROM meetings m LEFT JOIN organisations o ON o.id = m.org_id
     WHERE (coalesce(m.started_at, m.starts_at) AT TIME ZONE $1)::date
           BETWEEN coalesce($2::date, (now() AT TIME ZONE $1)::date - 14) AND coalesce($3::date, (now() AT TIME ZONE $1)::date + 14)
     ORDER BY coalesce(m.started_at, m.starts_at) DESC LIMIT 25`,
    [tz, from, to],
  );
  return {
    meetings: rows.map((r) => ({
      title: r.title,
      when: r.at,
      status: r.status,
      organisation: r.org ?? null,
      host: r.host,
      attended: r.attended,
      notes_ready: r.has_notes,
    })),
  };
}

export async function meetingNotesForAgent(client, membership, body = {}) {
  const tz = membership.workspace_timezone || 'Asia/Kolkata';
  const title = String(body.title ?? body.name ?? '').trim().slice(0, 200);
  const date = ISO_DAY.test(String(body.date ?? '')) ? body.date : null;
  const { rows } = await client.query(
    `SELECT m.id, m.title, coalesce(m.started_at, m.starts_at) AS at, m.summary_status,
            auth.workspace_member_name(m.host_membership_id) AS host,
            s.summary, s.decisions, s.action_items
     FROM meetings m LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
     WHERE m.status = 'ended'
       AND ($2 = '' OR m.title ILIKE '%' || $2 || '%')
       AND ($3::date IS NULL OR (coalesce(m.started_at, m.starts_at) AT TIME ZONE $1)::date = $3::date)
     ORDER BY coalesce(m.started_at, m.starts_at) DESC LIMIT 5`,
    [tz, title.replace(/[%_]/g, ''), date],
  );
  if (!rows.length) return { found: false, message: 'No ended meeting matches that.' };
  const [m, ...rest] = rows;
  const { rows: people } = await client.query(
    `SELECT auth.workspace_member_name(membership_id) AS name FROM meeting_participants WHERE meeting_id = $1 AND joined_at IS NOT NULL`,
    [m.id],
  );
  return {
    found: true,
    meeting: { title: m.title, when: m.at, host: m.host, attended: people.map((p) => p.name) },
    // Existing notes stay readable while a rewrite is in progress.
    notes:
      m.summary != null
        ? {
            summary: m.summary,
            decisions: m.decisions ?? [],
            action_items: (m.action_items ?? []).map((a) => ({ text: a.text, owner: a.owner_name ?? 'Unassigned', due: a.due_date, status: a.status })),
          }
        : null,
    notes_status: m.summary_status,
    other_matches: rest.map((r) => ({ title: r.title, when: r.at })),
  };
}
