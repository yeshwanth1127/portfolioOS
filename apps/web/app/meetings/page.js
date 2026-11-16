'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';
import { formatWhen, initials, meetingBucket as bucket, meetingIdFromLink } from '../lib/meetings.js';
import InvitePicker, { emptyInvitees, inviteeCount, useInviteDirectory } from '../components/invite-picker.js';
import { MEETINGS_CHANGED } from '../components/notification-bell.js';
import './meetings.css';

/**
 * Meetings: start one now or schedule one — always with someone (people, a team or an
 * organisation, who get an in-app notification) — join with a pasted link, and see live /
 * upcoming / past meetings.
 */

const TABS = [
  { value: 'live', label: 'Live now' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'past', label: 'Past' },
];
const DURATIONS = [15, 30, 45, 60, 90, 120];

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Value for <input type="datetime-local"> in the browser's own time zone. */
function localInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextHalfHour() {
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

const emptyDraft = () => ({
  title: '',
  starts_at: localInputValue(nextHalfHour()),
  duration_minutes: 30,
  description: '',
  invitees: emptyInvitees(),
  qlix_enabled: true,
});

export default function MeetingsPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [available, setAvailable] = useState(true);
  const [tab, setTab] = useState('upcoming');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [composer, setComposer] = useState(null); // null | 'now' | 'later'
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    setMounted(true);
    setSession(readStoredSession());
  }, []);

  const membership = session?.membership;
  const tz = membership?.workspace_timezone;

  const load = useCallback(async () => {
    if (!session?.token) return;
    setLoading(true);
    setError('');
    try {
      const data = await api('/meetings', session.token);
      setMeetings(data.meetings ?? []);
      setAvailable(data.available !== false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while someone is in a call, so "Live now" stays honest, and as soon as the bell
  // brings a meeting invite or cancellation.
  useEffect(() => {
    if (!session?.token) return undefined;
    const t = setInterval(load, 30000);
    window.addEventListener(MEETINGS_CHANGED, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(MEETINGS_CHANGED, load);
    };
  }, [session, load]);

  // The invite directory loads once the composer is first opened.
  const directory = useInviteDirectory(composer ? session?.token : null);

  const grouped = useMemo(() => {
    const out = { live: [], upcoming: [], past: [] };
    for (const m of meetings) out[bucket(m)].push(m);
    out.upcoming.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    out.live.sort((a, b) => new Date(b.started_at ?? b.starts_at) - new Date(a.started_at ?? a.starts_at));
    return out;
  }, [meetings]);

  // Open on the tab that has something in it.
  useEffect(() => {
    if (grouped.live.length) setTab('live');
  }, [grouped.live.length]);

  function openComposer(mode) {
    setComposer((c) => (c === mode ? null : mode));
    setError('');
    setNotice('');
  }

  async function submit(e) {
    e.preventDefault();
    if (!inviteeCount(draft.invitees)) {
      setError('Choose who the meeting is with.');
      return;
    }
    setBusy(true);
    setError('');
    const instant = composer === 'now';
    const firstName = membership?.full_name?.split(' ')[0] ?? 'Team';
    try {
      const { meeting, invited } = await api('/meetings', session.token, {
        method: 'POST',
        body: JSON.stringify({
          ...draft.invitees,
          title: draft.title.trim() || (instant ? `${firstName}'s meeting` : ''),
          description: draft.description,
          qlix_enabled: draft.qlix_enabled,
          ...(instant
            ? { instant: true }
            : { starts_at: new Date(draft.starts_at).toISOString(), duration_minutes: draft.duration_minutes }),
        }),
      });
      if (instant) {
        router.push(`/meetings/${meeting.id}?join=1`);
        return;
      }
      setComposer(null);
      setDraft(emptyDraft());
      setMeetings((ms) => [meeting, ...ms]);
      setTab('upcoming');
      setNotice(`Scheduled “${meeting.title}”. ${invited} ${invited === 1 ? 'person was' : 'people were'} invited and notified.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function joinWithLink(e) {
    e.preventDefault();
    const id = meetingIdFromLink(link);
    if (!id) {
      setLinkError('That doesn’t look like a meeting link. It should end in /meetings/… ');
      return;
    }
    setLinkError('');
    router.push(`/meetings/${id}`);
  }

  if (!mounted) return null;

  if (!session?.token) {
    return (
      <div className="app app-in-shell">
        <div className="board">
          <main className="sheet">
            <div className="stage-head"><div><h1>Meetings</h1></div></div>
            <p className="gs-empty"><a className="linkish" href="/">Sign in</a> to see your meetings.</p>
          </main>
        </div>
      </div>
    );
  }

  const list = grouped[tab];

  return (
    <div className="app app-in-shell">
      <div className="board">
        <main className="sheet">
          <div className="gs">
            <div className="stage-head mt-head">
              <div>
                <h1>Meetings</h1>
                <p>Video meetings with the people in your workspace.</p>
              </div>
              <div className="mt-head-actions">
                <button type="button" className={composer === 'later' ? 'primary' : 'quiet'} onClick={() => openComposer('later')} disabled={!available}>
                  Schedule
                </button>
                <button type="button" className={composer === 'now' ? 'primary' : 'quiet'} onClick={() => openComposer('now')} disabled={!available}>
                  Start a meeting now
                </button>
              </div>
            </div>

            {!available ? (
              <p className="err banner">Meetings aren’t set up on this server yet. Ask your administrator to start the meetings service.</p>
            ) : null}
            {error ? <p className="err banner">{error}</p> : null}
            {notice ? <p className="mt-notice" role="status">{notice}</p> : null}

            <form className="mt-joinlink" onSubmit={joinWithLink} aria-label="Join with a link">
              <label>
                <span>Have a meeting link?</span>
                <input
                  value={link}
                  onChange={(e) => {
                    setLink(e.target.value);
                    setLinkError('');
                  }}
                  placeholder="Paste it here, e.g. https://…/meetings/3f2c…"
                  inputMode="url"
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="quiet" disabled={!link.trim()}>Open</button>
              {linkError ? <p className="err mt-joinlink-err">{linkError}</p> : null}
            </form>

            {composer ? (
              <section className="gs-card" aria-label={composer === 'now' ? 'Start a meeting now' : 'Schedule a meeting'}>
                <div className="gs-list-head">
                  <h2>{composer === 'now' ? 'Start a meeting now' : 'Schedule a meeting'}</h2>
                  <button type="button" className="quiet" onClick={() => setComposer(null)}>Close</button>
                </div>
                <form onSubmit={submit} className="mt-form">
                  <div className="mt-wide">
                    <div className="mt-invite-head">
                      <span>Who is this meeting with? <em>required</em></span>
                    </div>
                    <InvitePicker
                      dir={directory.dir}
                      error={directory.error}
                      value={draft.invitees}
                      onChange={(invitees) => setDraft((d) => ({ ...d, invitees }))}
                    />
                  </div>

                  <div className="pp-fields">
                    <label>
                      <span>Title {composer === 'now' ? <em>optional</em> : null}</span>
                      <input
                        value={draft.title}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        required={composer === 'later'}
                        maxLength={200}
                        placeholder={composer === 'now' ? `${membership?.full_name?.split(' ')[0] ?? 'Team'}'s meeting` : 'e.g. Weekly review'}
                      />
                    </label>
                    {composer === 'later' ? (
                      <>
                        <label>
                          <span>Starts</span>
                          <input type="datetime-local" value={draft.starts_at} onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })} required />
                        </label>
                        <label>
                          <span>Length</span>
                          <select value={draft.duration_minutes} onChange={(e) => setDraft({ ...draft, duration_minutes: Number(e.target.value) })}>
                            {DURATIONS.map((d) => (
                              <option key={d} value={d}>{d < 60 ? `${d} minutes` : `${d / 60} hour${d > 60 ? 's' : ''}`}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                  <label className="mt-wide">
                    <span>Agenda <em>optional</em></span>
                    <textarea rows={composer === 'now' ? 2 : 3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={4000} placeholder="What should this meeting decide?" />
                  </label>

                  <label className="mt-check">
                    <input type="checkbox" checked={draft.qlix_enabled} onChange={(e) => setDraft({ ...draft, qlix_enabled: e.target.checked })} />
                    <span>
                      <b>Meeting Assistant attends</b>
                      <small>Qlix takes notes and writes a summary with action items after the call.</small>
                    </span>
                  </label>

                  <div className="mt-form-actions">
                    <span className="mt-hint">
                      {composer === 'now'
                        ? 'They’ll get a notification with a Join button as soon as you start.'
                        : 'They’ll get a notification now, a reminder 10 minutes before, and it goes on their calendar.'}
                    </span>
                    <button type="submit" className="primary" disabled={busy || !inviteeCount(draft.invitees) || (composer === 'later' && !draft.title.trim())}>
                      {busy ? 'Working…' : composer === 'now' ? 'Start and invite' : 'Schedule and invite'}
                    </button>
                  </div>
                </form>
              </section>
            ) : null}

            <section className="gs-card">
              <div className="tabs mt-tabs" role="tablist">
                {TABS.map((t) => (
                  <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? 'on' : ''} onClick={() => setTab(t.value)}>
                    {t.label}
                    {grouped[t.value].length ? <span className="mt-count">{grouped[t.value].length}</span> : null}
                  </button>
                ))}
              </div>

              {loading && !meetings.length ? <p className="gs-empty">Loading…</p> : null}
              {!loading && !list.length ? (
                <p className="gs-empty">
                  {tab === 'live' ? 'No one is in a meeting right now.' : tab === 'upcoming' ? 'Nothing scheduled. Schedule a meeting or start one now.' : 'No past meetings in the last 90 days.'}
                </p>
              ) : null}

              <ul className="mt-list">
                {list.map((m) => (
                  <li key={m.id}>
                    <a className="mt-row" href={`/meetings/${m.id}`}>
                      <span className={`mt-dot mt-dot-${bucket(m)}`} aria-hidden />
                      <span className="mt-row-main">
                        <b>{m.title}</b>
                        <small>
                          {formatWhen(m.status === 'live' && m.started_at ? m.started_at : m.starts_at, tz)}
                          {' · '}hosted by {m.host_membership_id === membership?.id ? 'you' : m.host_name}
                          {m.org ? ` · ${m.org}` : ''}
                        </small>
                      </span>
                      <span className="mt-row-side">
                        <Faces people={m.participants} />
                        {bucket(m) === 'live' ? <span className="mt-live">{m.in_call ? `${m.in_call} in call` : 'Live'}</span> : null}
                        {bucket(m) !== 'past' ? <span className="mt-join">Join</span> : null}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function Faces({ people }) {
  const shown = (people ?? []).slice(0, 4);
  const more = (people ?? []).length - shown.length;
  return (
    <span className="mt-faces" aria-label={`${people?.length ?? 0} people`}>
      {shown.map((p) => (
        <span key={p.membership_id} className="mt-avatar sm" title={p.name}>{initials(p.name)}</span>
      ))}
      {more > 0 ? <span className="mt-avatar sm more">+{more}</span> : null}
    </span>
  );
}
