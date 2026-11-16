'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { readStoredSession } from '../../lib/session.js';
import { durationLabel, formatWhen, initials, meetingBucket } from '../../lib/meetings.js';
import InvitePicker, { emptyInvitees, inviteeCount, useInviteDirectory } from '../../components/invite-picker.js';
import '../meetings.css';

const MeetingRoom = dynamic(() => import('../../components/meeting-room.js'), {
  ssr: false,
  loading: () => <div className="mt-prejoin"><p className="mt-hint">Getting the call ready…</p></div>,
});

/** One meeting: details, the call (pre-join → room), and after it ends, who attended. */
export default function MeetingPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(null);
  const [meeting, setMeeting] = useState(null);
  const [summary, setSummary] = useState(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('details'); // details | call
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setMounted(true);
    setSession(readStoredSession());
  }, []);

  const membership = session?.membership;
  const tz = membership?.workspace_timezone;

  const load = useCallback(async () => {
    if (!session?.token || !id) return;
    try {
      const data = await api(`/meetings/${id}`, session.token);
      setMeeting(data.meeting);
      setSummary(data.summary ?? null);
      setAvailable(data.available !== false);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [session, id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (meeting && searchParams.get('join') === '1' && meeting.status !== 'ended' && available) setStage('call');
  }, [meeting, searchParams, available]);

  // Keep attendance fresh on the details screen, and watch for the summary being written.
  const writing = ['pending', 'running'].includes(meeting?.summary_status);
  useEffect(() => {
    if (stage !== 'details' || !session?.token) return undefined;
    if (meeting?.status === 'ended' && !writing) return undefined;
    const t = setInterval(load, writing ? 4000 : 15000);
    return () => clearInterval(t);
  }, [stage, session, load, meeting?.status, writing]);

  async function writeSummary() {
    setBusy(true);
    try {
      const data = await api(`/meetings/${id}/summary`, session.token, { method: 'POST', body: '{}' });
      setMeeting((m) => ({ ...m, ...data.meeting }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const getToken = useCallback(
    () => api(`/meetings/${id}/token`, session.token, { method: 'POST', body: '{}' }),
    [id, session],
  );

  function leave() {
    setStage('details');
    router.replace(`/meetings/${id}`);
    load();
  }

  async function endForAll() {
    if (!window.confirm('End this meeting for everyone?')) return;
    setBusy(true);
    try {
      const data = await api(`/meetings/${id}/end`, session.token, { method: 'POST', body: '{}' });
      setMeeting(data.meeting);
      setStage('details');
      router.replace(`/meetings/${id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelMeeting() {
    if (!window.confirm('Cancel this meeting? It will also be removed from the calendar.')) return;
    setBusy(true);
    try {
      await api(`/meetings/${id}`, session.token, { method: 'DELETE' });
      router.push('/meetings');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  // The link opens this meeting for anyone who can see it: the people invited, and (for a
  // meeting that belongs to an organisation) that organisation. Others are told to ask the host.
  async function copyLink() {
    const url = `${window.location.origin}/meetings/${id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this meeting link:', url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  function inviteDone(updated, invited) {
    setMeeting((m) => ({ ...m, ...updated }));
    setInviting(false);
    setNotice(invited ? `Invited ${invited} ${invited === 1 ? 'person' : 'people'}. They’ve been notified.` : 'Everyone you picked was already invited.');
    setTimeout(() => setNotice(''), 5000);
  }

  if (!mounted) return null;

  if (!session?.token) {
    return (
      <div className="app app-in-shell">
        <div className="board">
          <main className="sheet">
            <div className="stage-head"><div><h1>Meeting</h1></div></div>
            <p className="gs-empty"><a className="linkish" href="/">Sign in</a> to join this meeting.</p>
          </main>
        </div>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="app app-in-shell">
        <div className="board">
          <main className="sheet">
            <div className="stage-head"><div><h1>Meeting</h1></div></div>
            {error ? (
              /not found/i.test(error) ? (
                <p className="gs-empty">
                  This meeting doesn’t exist, or you haven’t been invited to it. Ask the host to invite you, then open the link again.
                </p>
              ) : (
                <p className="err banner">{error}</p>
              )
            ) : (
              <p className="gs-empty">Loading…</p>
            )}
            <p><a className="linkish" href="/meetings">Back to meetings</a></p>
          </main>
        </div>
      </div>
    );
  }

  const when = meetingBucket(meeting);
  const ended = meeting.status === 'ended';
  const attended = meeting.participants.filter((p) => p.joined_at);
  const invitedOnly = meeting.participants.filter((p) => !p.joined_at);

  if (stage === 'call') {
    return (
      <div className="mt-call">
        <div className="mt-call-bar">
          <div className="mt-call-title">
            <span className="mt-dot mt-dot-live" aria-hidden />
            <b>{meeting.title}</b>
            {meeting.qlix_enabled ? <span className="mt-chip">Meeting Assistant on</span> : null}
          </div>
          <div className="mt-call-actions">
            {meeting.can_manage ? (
              <button type="button" className="quiet" onClick={() => setInviting((v) => !v)}>{inviting ? 'Close' : 'Invite people'}</button>
            ) : null}
            <button type="button" className="quiet" onClick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</button>
            {meeting.can_end ? (
              <button type="button" className="mt-danger" onClick={endForAll} disabled={busy}>End for everyone</button>
            ) : null}
          </div>
        </div>
        {error ? <p className="err banner">{error}</p> : null}
        {notice ? <p className="mt-notice" role="status">{notice}</p> : null}
        {inviting ? (
          <div className="mt-call-invite">
            <InvitePanel meeting={meeting} token={session.token} onDone={inviteDone} onCancel={() => setInviting(false)} />
          </div>
        ) : null}
        <div className="mt-call-body">
          <MeetingRoom
            userName={membership?.full_name ?? ''}
            getToken={getToken}
            onLeave={leave}
            onError={setError}
            assistantOn={meeting.qlix_enabled}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app app-in-shell">
      <div className="board">
        <main className="sheet">
          <div className="gs">
            <p className="mt-back"><a className="linkish" href="/meetings">← Meetings</a></p>
            <div className="stage-head mt-head">
              <div>
                <h1>{meeting.title}</h1>
                <p>
                  {formatWhen(meeting.started_at && when !== 'upcoming' ? meeting.started_at : meeting.starts_at, tz)}
                  {' · '}hosted by {meeting.host_membership_id === membership?.id ? 'you' : meeting.host_name}
                  {meeting.org ? ` · ${meeting.org}` : ''}
                </p>
              </div>
              <div className="mt-head-actions">
                {meeting.can_manage && !ended ? (
                  <button type="button" className={inviting ? 'primary' : 'quiet'} onClick={() => setInviting((v) => !v)}>Invite people</button>
                ) : null}
                {!ended ? <button type="button" className="quiet" onClick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</button> : null}
                {meeting.can_end && meeting.status === 'scheduled' ? (
                  <button type="button" className="quiet" onClick={cancelMeeting} disabled={busy}>Cancel meeting</button>
                ) : null}
                {meeting.can_end && meeting.status === 'live' ? (
                  <button type="button" className="mt-danger" onClick={endForAll} disabled={busy}>End for everyone</button>
                ) : null}
                {!ended ? (
                  <button type="button" className="primary" onClick={() => setStage('call')} disabled={!available}>
                    {meeting.status === 'live' ? 'Join now' : 'Join'}
                  </button>
                ) : null}
              </div>
            </div>

            {!available && !ended ? (
              <p className="err banner">Meetings aren’t set up on this server yet. Ask your administrator to start the meetings service.</p>
            ) : null}
            {error ? <p className="err banner">{error}</p> : null}
            {notice ? <p className="mt-notice" role="status">{notice}</p> : null}
            {copied ? (
              <p className="mt-hint" role="status">
                Link copied. It opens the meeting for the people invited{meeting.org ? ` and everyone in ${meeting.org}` : ''}; invite anyone else first.
              </p>
            ) : null}
            {inviting ? (
              <section className="gs-card" aria-label="Invite people">
                <InvitePanel meeting={meeting} token={session.token} onDone={inviteDone} onCancel={() => setInviting(false)} />
              </section>
            ) : null}

            <div className="mt-detail-grid">
              <section className="gs-card">
                <div className="gs-list-head">
                  <h2>{ended ? 'Summary' : 'About this meeting'}</h2>
                  <StatusChip meeting={meeting} />
                </div>
                {ended ? (
                  <dl className="mt-facts">
                    <div><dt>Started</dt><dd>{meeting.started_at ? formatWhen(meeting.started_at, tz) : '—'}</dd></div>
                    <div>
                      <dt>Lasted</dt>
                      <dd>{meeting.started_at && meeting.ended_at ? durationLabel(new Date(meeting.ended_at) - new Date(meeting.started_at)) : '—'}</dd>
                    </div>
                    <div><dt>Attended</dt><dd>{attended.length} {attended.length === 1 ? 'person' : 'people'}</dd></div>
                  </dl>
                ) : null}
                {meeting.description ? <p className="mt-agenda">{meeting.description}</p> : !ended ? <p className="mt-hint">No agenda added.</p> : null}
                {!ended && meeting.qlix_enabled ? (
                  <AssistantNote>Qlix joins the call to take notes, then writes a summary with decisions and action items.</AssistantNote>
                ) : null}
                {ended ? (
                  <AssistantSummary
                    meeting={meeting}
                    summary={summary}
                    busy={busy}
                    onWrite={writeSummary}
                    token={session.token}
                    onChanged={load}
                  />
                ) : null}
              </section>

              <section className="gs-card">
                <div className="gs-list-head">
                  <h2>People</h2>
                  {meeting.in_call ? <span className="mt-live">{meeting.in_call} in call</span> : null}
                </div>
                <ul className="mt-roster">
                  {[...attended, ...invitedOnly].map((p) => {
                    const inCall = p.joined_at && (!p.left_at || new Date(p.left_at) < new Date(p.joined_at)) && !ended;
                    return (
                      <li key={p.membership_id}>
                        <span className="mt-avatar" aria-hidden>{initials(p.name)}</span>
                        <span className="mt-person-text">
                          <b>{p.name}{p.membership_id === membership?.id ? ' (you)' : ''}</b>
                          <small>
                            {p.role === 'host' ? 'Host · ' : ''}
                            {inCall ? 'In the call' : p.joined_at ? (ended ? 'Attended' : 'Left') : ended ? 'Didn’t join' : 'Invited'}
                          </small>
                        </span>
                        {inCall ? <span className="mt-dot mt-dot-live" aria-hidden /> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>

            {ended && meeting.transcript_lines ? (
              <Transcript id={id} token={session.token} count={meeting.transcript_lines} />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Host / manager: invite more people, a team or an organisation to this meeting. */
function InvitePanel({ meeting, token, onDone, onCancel }) {
  const directory = useInviteDirectory(token);
  const [value, setValue] = useState(emptyInvitees);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const already = useMemo(() => meeting.participants.filter((p) => p.invited).map((p) => p.membership_id), [meeting.participants]);

  async function send() {
    setBusy(true);
    setError('');
    try {
      const data = await api(`/meetings/${meeting.id}/participants`, token, { method: 'POST', body: JSON.stringify(value) });
      onDone(data.meeting, data.invited);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="mt-form">
      <div className="gs-list-head">
        <h2>Invite people</h2>
        <button type="button" className="quiet" onClick={onCancel}>Close</button>
      </div>
      <InvitePicker dir={directory.dir} error={directory.error} value={value} onChange={setValue} exclude={already} />
      {error ? <p className="err">{error}</p> : null}
      <div className="mt-form-actions">
        <span className="mt-hint">{meeting.status === 'live' ? 'They’ll get a notification with a Join button right away.' : 'They’ll get a notification and the meeting goes on their calendar.'}</span>
        <button type="button" className="primary" onClick={send} disabled={busy || !inviteeCount(value)}>{busy ? 'Inviting…' : 'Send invites'}</button>
      </div>
    </div>
  );
}

const SparkIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8" />
  </svg>
);

function AssistantNote({ children, action }) {
  return (
    <div className="mt-assistant">
      <span className="mt-assistant-icon"><SparkIcon /></span>
      <div>
        <b>Meeting Assistant</b>
        <p>{children}</p>
        {action}
      </div>
    </div>
  );
}

function formatDue(date) {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** After the call: the Qlix Meeting Assistant's summary, or where it is in writing one. */
function AssistantSummary({ meeting, summary, busy, onWrite, token, onChanged }) {
  const st = meeting.summary_status;
  const canWrite = meeting.can_manage;
  const writeButton = (label) =>
    canWrite ? (
      <button type="button" className="quiet mt-assistant-action" onClick={onWrite} disabled={busy}>{label}</button>
    ) : null;

  if (st === 'pending' || st === 'running') {
    return (
      <AssistantNote>
        <span className="mt-writing">Writing the notes<span aria-hidden>…</span></span> This usually takes under a minute.
      </AssistantNote>
    );
  }
  if (st === 'failed') {
    return (
      <AssistantNote action={writeButton('Try again')}>
        The notes couldn’t be written: {meeting.summary_error || 'something went wrong'}.
      </AssistantNote>
    );
  }
  if (st === 'empty') {
    return <AssistantNote action={writeButton('Try again')}>The Meeting Assistant didn’t hear anything to summarise.</AssistantNote>;
  }
  if (st === 'none' || !summary) {
    return meeting.transcript_lines || canWrite ? (
      <AssistantNote action={writeButton('Write notes with Qlix')}>
        {meeting.qlix_enabled ? 'No notes yet.' : 'The Meeting Assistant was off for this meeting.'}
      </AssistantNote>
    ) : null;
  }

  const items = summary.action_items ?? [];
  return (
    <div className="mt-notes">
      <div className="mt-notes-head">
        <span className="mt-assistant-icon"><SparkIcon /></span>
        <b>Notes from the Meeting Assistant</b>
        {writeButton('Rewrite')}
      </div>
      <p className="mt-notes-summary">{summary.summary}</p>
      {summary.decisions?.length ? (
        <>
          <h3>Decisions</h3>
          <ul className="mt-decisions">
            {summary.decisions.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </>
      ) : null}
      {items.length ? (
        <>
          <h3>Action items</h3>
          <ul className="mt-actions">
            {items.map((a, i) => (
              <ActionItem key={i} index={i} item={a} meeting={meeting} token={token} canDecide={canWrite} onChanged={onChanged} />
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-hint">Written by Qlix from the meeting transcript. Speech-to-text can mishear names and words.</p>
    </div>
  );
}

/** One proposed action item: accept it into a project as a task, or dismiss it. */
function ActionItem({ index, item, meeting, token, canDecide, onChanged }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState(null);
  const [form, setForm] = useState({ project_id: '', assignee_id: item.owner_membership_id ?? '', due_on: item.due_date ?? '', title: item.text });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || projects) return;
    api('/projects', token)
      .then((d) => {
        const list = (d.projects ?? []).filter((p) => p.status !== 'done' && p.status !== 'cancelled');
        setProjects(list);
        if (list.length === 1) setForm((f) => ({ ...f, project_id: list[0].id }));
      })
      .catch((e) => setError(e.message));
  }, [open, projects, token]);

  async function decide(decision) {
    setBusy(true);
    setError('');
    try {
      await api(`/meetings/${meeting.id}/action-items/${index}`, token, {
        method: 'POST',
        body: JSON.stringify(decision === 'accept' ? { decision, ...form, assignee_id: form.assignee_id || null, due_on: form.due_on || null } : { decision }),
      });
      setOpen(false);
      await onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const done = item.status !== 'proposed';
  return (
    <li className={`mt-action is-${item.status}`}>
      <span className={`mt-check-box${item.status === 'accepted' ? ' is-on' : ''}`} aria-hidden>
        {item.status === 'accepted' ? '✓' : null}
      </span>
      <div className="mt-action-body">
        <span className="mt-action-text">
          {item.text}
          <small>
            {item.owner_name ?? 'Unassigned'}
            {item.due_date ? ` · due ${formatDue(item.due_date)}` : ''}
            {item.status === 'accepted' ? ' · added as a task' : item.status === 'rejected' ? ' · dismissed' : ''}
          </small>
        </span>
        {open ? (
          <form
            className="mt-accept"
            onSubmit={(e) => {
              e.preventDefault();
              decide('accept');
            }}
          >
            <label>
              <span>Task</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={300} required />
            </label>
            <label>
              <span>Project</span>
              <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} required>
                <option value="">{projects ? (projects.length ? 'Pick a project' : 'No open projects') : 'Loading…'}</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.unit_name ? ` · ${p.unit_name}` : ''}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Assignee</span>
              <select value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                <option value="">Unassigned</option>
                {meeting.participants.map((p) => (
                  <option key={p.membership_id} value={p.membership_id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Due</span>
              <input type="date" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} />
            </label>
            <div className="mt-accept-actions">
              <button type="button" className="quiet" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="primary" disabled={busy || !form.project_id || !form.title.trim()}>Create task</button>
            </div>
          </form>
        ) : null}
        {error ? <p className="err">{error}</p> : null}
      </div>
      {canDecide && !done && !open ? (
        <span className="mt-action-buttons">
          <button type="button" className="quiet" onClick={() => setOpen(true)}>Add as task</button>
          <button type="button" className="mt-link" onClick={() => decide('reject')} disabled={busy}>Dismiss</button>
        </span>
      ) : null}
    </li>
  );
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function Transcript({ id, token, count }) {
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open || segments) return;
    api(`/meetings/${id}/transcript`, token).then((d) => setSegments(d.segments ?? [])).catch(() => setSegments([]));
  }, [open, segments, id, token]);
  const shown = (segments ?? []).filter((s) => !q.trim() || `${s.speaker_name} ${s.text}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="gs-card mt-transcript">
      <div className="gs-list-head">
        <h2>Transcript <small>{count} {count === 1 ? 'line' : 'lines'}</small></h2>
        <div className="mt-head-actions">
          {open ? <input className="mt-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" /> : null}
          <button type="button" className="quiet" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {open ? (
        segments ? (
          <ol className="mt-lines">
            {shown.map((s, i) => (
              <li key={i}>
                <span className="mt-time">{clock(s.started_ms)}</span>
                <span><b>{s.speaker_name}</b> {s.text}</span>
              </li>
            ))}
            {!shown.length ? <li className="mt-hint">No lines match.</li> : null}
          </ol>
        ) : (
          <p className="mt-hint">Loading…</p>
        )
      ) : null}
    </section>
  );
}

function StatusChip({ meeting }) {
  const b = meetingBucket(meeting);
  const label = meeting.status === 'live' ? 'Live' : meeting.status === 'ended' ? 'Ended' : b === 'past' ? 'Missed' : 'Scheduled';
  return <span className={`mt-chip mt-chip-${b}`}>{label}</span>;
}
