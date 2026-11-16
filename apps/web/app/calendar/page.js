'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEventTime, todayISO } from '../lib/dates.js';
import { api, API } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';

const RESPONSE_LABEL = {
  pending: 'Pending',
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
};

function ParticipantChips({ participants }) {
  if (!Array.isArray(participants) || participants.length === 0) return null;
  return (
    <div className="calendar-participants">
      {participants.map((p) => (
        <span
          key={p.membership_id}
          className={`calendar-rsvp-chip response-${p.response ?? 'pending'}`}
        >
          {p.name}
          <em>{RESPONSE_LABEL[p.response] ?? p.response}</em>
        </span>
      ))}
    </div>
  );
}

function EventRsvp({ item, membershipId, disabled, onRespond }) {
  if (item.source !== 'event' || !membershipId) return null;
  const participants = Array.isArray(item.participants) ? item.participants : [];
  const me = participants.find((p) => p.membership_id === membershipId);
  if (!me) return null;
  const choices = [
    { value: 'yes', label: 'Yes' },
    { value: 'maybe', label: 'Maybe' },
    { value: 'no', label: 'No' },
  ];
  return (
    <div className="calendar-rsvp-actions" onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
      <span className="calendar-rsvp-prompt">Your RSVP</span>
      {choices.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={`calendar-rsvp-btn${me.response === value ? ' active' : ''}`}
          disabled={disabled}
          onClick={() => onRespond(item.id, value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthEnds(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function monthLabel(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function isoAtDay(year, monthIndex, day) {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

/** Monday-start month grid: each cell is { iso } or null for padding. */
function buildMonthCells(year, monthIndex) {
  const start = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const count = monthEnds(year, monthIndex);
  return Array.from({ length: start + count }, (_, i) => {
    if (i < start) return null;
    const day = i - start + 1;
    return { iso: isoAtDay(year, monthIndex, day), day };
  });
}

const DATED_SOURCES = new Set(['lock', 'task', 'milestone', 'target']);
const STATUS_RANK = { bad: 3, watch: 2, good: 1, none: 0 };
const KPI_STATUS_LABEL = {
  met: 'Met',
  close: 'Close',
  missed: 'Missed',
  pending: 'Awaiting validation',
  no_data: 'Not reported',
  unscored: 'Not scored',
};

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** One organisation's results for a period against the goals set on Set goals. */
function TargetResult({ item }) {
  const cadence = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter' }[item.cadence] ?? '';
  const range = item.period_start === item.period_end ? '' : `${item.period_start.slice(8)}–${item.period_end.slice(8)} ${new Date(`${item.period_end}T12:00:00`).toLocaleString('en-IN', { month: 'short' })}`;
  return (
    <details className={`target-result target-${item.status}`}>
      <summary>
        <span className={`target-dot target-dot-${item.status}`} aria-hidden />
        <span className="target-result-head">
          <b>{item.title}</b>
          <small>{[cadence && range ? `${cadence} ${range}` : null, item.detail].filter(Boolean).join(' · ')}</small>
        </span>
        <span className="target-result-score">
          {item.summary.met}/{item.kpis.length}
        </span>
      </summary>
      <table className="target-table">
        <thead>
          <tr>
            <th>Measure</th>
            <th>Done</th>
            <th>{item.in_progress ? 'On pace' : 'Target'}</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {item.kpis.map((k) => (
            <tr key={k.kpi_id}>
              <td>{k.name}</td>
              <td className="num">{fmtNum(k.actual)}{k.actual != null && k.unit === '%' ? '%' : ''}</td>
              <td className="num">
                {fmtNum(k.judged_against)}{k.unit === '%' ? '%' : ''}
                {k.direction === 'lower_is_better' ? <small> max</small> : null}
              </td>
              <td><span className={`target-chip target-chip-${k.status}`}>{KPI_STATUS_LABEL[k.status] ?? k.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function eventOnDay(item, iso, tz) {
  if (DATED_SOURCES.has(item.source)) return item.date === iso;
  if (!item.starts_at) return false;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(item.starts_at));
  return day === iso;
}

function toDatetimeLocal(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStartForDay(iso) {
  const d = new Date(`${iso}T09:00:00`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CalendarPage() {
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState(null);
  const [icsUrl, setIcsUrl] = useState(null);
  const [view, setView] = useState(() => {
    const t = todayISO();
    return { year: Number(t.slice(0, 4)), month: Number(t.slice(5, 7)) - 1 };
  });
  const [selectedDay, setSelectedDay] = useState(() => todayISO());
  const [showTargets, setShowTargets] = useState(true);
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [people, setPeople] = useState([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [form, setForm] = useState({
    title: '',
    starts_at: '',
    ends_at: '',
    location: '',
    description: '',
    org_id: '',
    participant_ids: [],
  });

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    setSession(readStoredSession());
  }, [mounted]);

  const range = useMemo(() => {
    const from = isoAtDay(view.year, view.month, 1);
    const to = isoAtDay(view.year, view.month, monthEnds(view.year, view.month));
    return { from, to };
  }, [view]);

  const loadFeed = useCallback(async () => {
    if (!session?.token) return;
    setError('');
    try {
      const data = await api(`/calendar?from=${range.from}&to=${range.to}`, session.token);
      setFeed(data);
    } catch (err) {
      setError(err.message);
    }
  }, [session, range.from, range.to]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    if (!session?.token) return;
    api('/orgs', session.token)
      .then((data) => setOrgs(data.orgs ?? []))
      .catch(() => setOrgs([]));
  }, [session]);

  const loadPeopleForPicker = useCallback(
    async (orgId) => {
      if (!session?.token) return;
      const isOwner = session.membership?.role === 'owner';
      setPeopleLoading(true);
      try {
        if (!isOwner || orgId) {
          const slug = orgId
            ? orgs.find((o) => o.id === orgId)?.slug
            : session.membership?.org_slug;
          if (!slug) {
            setPeople([]);
            return;
          }
          const data = await api(`/orgs/${slug}/people`, session.token);
          setPeople(data.people ?? []);
          return;
        }
        const lists = await Promise.all(
          orgs.map((o) =>
            api(`/orgs/${o.slug}/people`, session.token)
              .then((d) => d.people ?? [])
              .catch(() => []),
          ),
        );
        const byId = new Map();
        for (const p of lists.flat()) byId.set(p.id, p);
        setPeople(
          [...byId.values()].sort((a, b) => String(a.full_name ?? '').localeCompare(String(b.full_name ?? ''))),
        );
      } catch {
        setPeople([]);
      } finally {
        setPeopleLoading(false);
      }
    },
    [session, orgs],
  );

  useEffect(() => {
    if (!modal || !session?.token) return;
    const orgId =
      session.membership?.role === 'owner' ? form.org_id : session.membership?.org_id ?? '';
    loadPeopleForPicker(orgId || null);
  }, [modal, form.org_id, session, orgs, loadPeopleForPicker]);

  const tz = feed?.timezone ?? 'Asia/Kolkata';
  const today = feed?.today ?? todayISO();
  const allItems = feed?.items ?? [];
  const items = useMemo(() => allItems.filter((i) => i.source !== 'target'), [allItems]);
  const targetItems = useMemo(
    () => (showTargets ? allItems.filter((i) => i.source === 'target') : []),
    [allItems, showTargets],
  );

  /** Worst result per day, for the coloured marker on the month grid. */
  const targetStatusByDay = useMemo(() => {
    const map = new Map();
    for (const t of targetItems) {
      const prev = map.get(t.date);
      if (!prev || STATUS_RANK[t.status] > STATUS_RANK[prev]) map.set(t.date, t.status);
    }
    return map;
  }, [targetItems]);

  const dayTargets = useMemo(
    () =>
      targetItems
        .filter((t) => t.date === selectedDay)
        .sort((a, b) => {
          const order = { quarter: 0, month: 1, week: 2, day: 3 };
          return (order[a.cadence] - order[b.cadence]) || String(a.org).localeCompare(String(b.org));
        }),
    [targetItems, selectedDay],
  );

  const cells = useMemo(() => buildMonthCells(view.year, view.month), [view]);

  const daysWithEvents = useMemo(() => {
    const set = new Set();
    for (const cell of cells) {
      if (!cell) continue;
      if (items.some((i) => eventOnDay(i, cell.iso, tz))) set.add(cell.iso);
    }
    return set;
  }, [cells, items, tz]);

  const dayItems = useMemo(
    () =>
      items
        .filter((i) => eventOnDay(i, selectedDay, tz))
        .sort((a, b) => {
          const dayKey = (i) => (DATED_SOURCES.has(i.source) ? i.date : i.starts_at);
          const ta = dayKey(a);
          const tb = dayKey(b);
          return String(ta).localeCompare(String(tb));
        }),
    [items, selectedDay, tz],
  );

  function prevMonth() {
    setView((v) => {
      if (v.month === 0) return { year: v.year - 1, month: 11 };
      return { ...v, month: v.month - 1 };
    });
  }

  function nextMonth() {
    setView((v) => {
      if (v.month === 11) return { year: v.year + 1, month: 0 };
      return { ...v, month: v.month + 1 };
    });
  }

  function openCreate() {
    setEditing(null);
    const membership = session?.membership;
    const defaultOrg =
      membership?.role === 'owner' ? '' : membership?.org_id ?? '';
    setForm({
      title: '',
      starts_at: defaultStartForDay(selectedDay),
      ends_at: '',
      location: '',
      description: '',
      org_id: defaultOrg,
      participant_ids: [],
    });
    setModal('create');
  }

  function openEdit(item) {
    if (item.source !== 'event' || !item.editable) return;
    setEditing(item);
    const participants = Array.isArray(item.participants) ? item.participants : [];
    setForm({
      title: item.title ?? '',
      starts_at: item.starts_at ? toDatetimeLocal(item.starts_at) : '',
      ends_at: item.ends_at ? toDatetimeLocal(item.ends_at) : '',
      location: item.location ?? '',
      description: item.description ?? '',
      org_id: item.org_id ?? '',
      participant_ids: participants.map((p) => p.membership_id).filter(Boolean),
    });
    setModal('edit');
  }

  async function exportIcs() {
    try {
      const { token } = await api('/calendar/ics-token', session.token);
      setIcsUrl(`${API}/calendar.ics?token=${encodeURIComponent(token)}`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEvent(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.starts_at) return;
    setBusy(true);
    setError('');
    try {
      const starts_at = new Date(form.starts_at).toISOString();
      const ends_at = form.ends_at
        ? new Date(form.ends_at).toISOString()
        : new Date(new Date(form.starts_at).getTime() + 3600000).toISOString();
      const body = {
        title: form.title.trim(),
        starts_at,
        ends_at,
        kind: editing?.kind ?? 'meeting',
        location: form.location.trim() || null,
        description: form.description.trim() || null,
        participant_ids: form.participant_ids,
      };
      const membership = session.membership;
      if (membership.role === 'owner') {
        body.org_id = form.org_id || null;
      } else if (membership.org_id) {
        body.org_id = membership.org_id;
      }

      if (modal === 'edit' && editing?.id) {
        await api(`/calendar/events/${editing.id}`, session.token, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await api('/calendar/events', session.token, { method: 'POST', body: JSON.stringify(body) });
      }
      setModal(null);
      setEditing(null);
      await loadFeed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function respondToEvent(eventId, response) {
    setBusy(true);
    setError('');
    try {
      await api(`/calendar/events/${eventId}/respond`, session.token, {
        method: 'POST',
        body: JSON.stringify({ response }),
      });
      await loadFeed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteEvent() {
    if (!editing?.id) return;
    if (!window.confirm(`Delete "${editing.title}"?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/calendar/events/${editing.id}`, session.token, { method: 'DELETE' });
      setModal(null);
      setEditing(null);
      await loadFeed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  if (!session?.token) {
    return (
      <div className="app app-in-shell">
        <div className="board">
          <div className="sheet calendar-page">
          <header className="calendar-page-head">
            <a href="/" className="calendar-page-back">← Overview</a>
            <h1>Calendar</h1>
          </header>
          <p className="overview-muted">Sign in on the home page to view and manage your calendar.</p>
          <p>
            <a href="/" className="linkish">Go to sign in</a>
          </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app app-in-shell">
      <div className="board">
        <div className="sheet calendar-page">
        <header className="calendar-page-head">
          <a href="/" className="calendar-page-back">← Overview</a>
          <div className="calendar-page-title-row">
            <h1>Calendar</h1>
            <div className="calendar-page-actions">
              <button type="button" className="quiet" onClick={prevMonth} aria-label="Previous month">‹</button>
              <span className="calendar-page-month-label">{monthLabel(view.year, view.month)}</span>
              <button type="button" className="quiet" onClick={nextMonth} aria-label="Next month">›</button>
              <button type="button" className="pill dark" onClick={openCreate}>Add event</button>
              <button type="button" className="quiet" onClick={() => loadFeed()} title="Refresh">↻</button>
              <button type="button" className="quiet" onClick={exportIcs} title="ICS export link">Export</button>
              <label className="calendar-target-toggle">
                <input type="checkbox" checked={showTargets} onChange={(e) => setShowTargets(e.target.checked)} />
                Targets
              </label>
            </div>
          </div>
        </header>

        {error && <p className="err banner">{error}</p>}
        {icsUrl && (
          <p className="calendar-ics-hint">
            <a href={icsUrl} target="_blank" rel="noreferrer">Subscribe in calendar app</a>
          </p>
        )}

        <div className="calendar-page-layout">
          <section className="calendar-page-month cal">
            <div className="cal-grid cal-dow">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="cal-grid calendar-page-grid">
              {cells.map((cell, i) => {
                if (!cell) return <span key={`pad-${i}`} aria-hidden="true" />;
                const isToday = cell.iso === today;
                const isSelected = cell.iso === selectedDay;
                const hasEvents = daysWithEvents.has(cell.iso);
                const targetStatus = targetStatusByDay.get(cell.iso);
                const cls = [
                  'cal-day-btn',
                  isToday ? 'rose-today' : '',
                  isSelected ? 'selected' : '',
                  hasEvents ? 'has-events' : '',
                  targetStatus ? `has-target target-${targetStatus}` : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={cell.iso}
                    type="button"
                    className={cls}
                    onClick={() => setSelectedDay(cell.iso)}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
            {showTargets ? (
              <div className="calendar-target-legend" aria-label="Target results legend">
                <span><i className="target-dot target-dot-good" /> All targets met</span>
                <span><i className="target-dot target-dot-watch" /> Some close</span>
                <span><i className="target-dot target-dot-bad" /> Some missed</span>
                <span><i className="calendar-legend-event" /> Event or deadline</span>
              </div>
            ) : null}
          </section>

          <aside className="calendar-page-day">
            <div className="calendar-page-day-head">
              <h2>
                {new Intl.DateTimeFormat('en-IN', {
                  timeZone: tz,
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                }).format(new Date(`${selectedDay}T12:00:00`))}
              </h2>
              <button type="button" className="quiet" onClick={openCreate}>+ Add</button>
            </div>
            {dayTargets.length > 0 && (
              <section className="calendar-targets" aria-label="Results against targets">
                <p className="calendar-targets-label">Results against targets</p>
                {dayTargets.map((t) => (
                  <TargetResult key={t.id} item={t} />
                ))}
              </section>
            )}
            {dayItems.length === 0 ? (
              dayTargets.length ? null : (
                <p className="overview-muted">Nothing on this day — events, deadlines, days to close and target results appear here.</p>
              )
            ) : (
              <ul className="calendar-timeline-list">
                {dayItems.map((item) => (
                  <li key={item.id} className="calendar-day-row">
                    <button
                      type="button"
                      className={`timeline-item source-${item.source} calendar-day-item${item.source === 'event' && item.editable ? ' editable' : ''}`}
                      onClick={() => openEdit(item)}
                      disabled={item.source !== 'event' || !item.editable}
                    >
                      <span className="timeline-time">
                        {DATED_SOURCES.has(item.source)
                          ? 'All day'
                          : formatEventTime(item.starts_at, tz, { allDay: item.all_day })}
                      </span>
                      <div className="timeline-body">
                        <b>{item.title}</b>
                        {item.project_name && <small>{item.project_name}</small>}
                        {item.org && <small>{item.org}</small>}
                        {item.detail && <small>{item.detail}</small>}
                        {item.source === 'event' && item.created_by_name && (
                          <small>By {item.created_by_name}</small>
                        )}
                        {item.source === 'event' && (
                          <ParticipantChips participants={item.participants} />
                        )}
                        {item.source === 'event' && !item.editable && (
                          <small>View only</small>
                        )}
                      </div>
                    </button>
                    {item.source === 'event' && /^\/meetings\/[0-9a-f-]{36}$/.test(item.location ?? '') ? (
                      <a className="calendar-join" href={item.location}>Join video meeting</a>
                    ) : null}
                    <EventRsvp
                      item={item}
                      membershipId={session.membership?.id}
                      disabled={busy}
                      onRespond={respondToEvent}
                    />
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
        </div>
      </div>

      {modal && (
        <div className="calendar-modal-backdrop" role="presentation" onClick={() => !busy && setModal(null)}>
          <form
            className="calendar-modal"
            onClick={(ev) => ev.stopPropagation()}
            onSubmit={saveEvent}
          >
            <h3>{modal === 'edit' ? 'Edit event' : 'Add event'}</h3>
            <label>
              Title
              <input
                value={form.title}
                onChange={(ev) => setForm({ ...form, title: ev.target.value })}
                required
                maxLength={200}
              />
            </label>
            <label>
              Starts
              <input
                type="datetime-local"
                value={form.starts_at}
                onChange={(ev) => setForm({ ...form, starts_at: ev.target.value })}
                required
              />
            </label>
            <label>
              Ends (optional)
              <input
                type="datetime-local"
                value={form.ends_at}
                onChange={(ev) => setForm({ ...form, ends_at: ev.target.value })}
              />
            </label>
            <label>
              Location (optional)
              <input
                value={form.location}
                onChange={(ev) => setForm({ ...form, location: ev.target.value })}
                maxLength={200}
              />
            </label>
            <label>
              Notes (optional)
              <textarea
                rows={3}
                value={form.description}
                onChange={(ev) => setForm({ ...form, description: ev.target.value })}
                maxLength={2000}
              />
            </label>
            {session.membership?.role === 'owner' ? (
              <label>
                Organisation
                <select
                  value={form.org_id}
                  onChange={(ev) =>
                    setForm({ ...form, org_id: ev.target.value, participant_ids: [] })
                  }
                >
                  <option value="">Personal / workspace</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.short_name ?? o.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              session.membership?.org_id && (
                <p className="overview-muted calendar-modal-org-hint">
                  Organisation:{' '}
                  {orgs.find((o) => o.id === session.membership.org_id)?.short_name ?? 'Your organisation'}
                </p>
              )
            )}
            <div className="calendar-participant-field">
              <span className="calendar-participant-field-label">Participants (optional)</span>
              <div className="calendar-participant-picker">
                {peopleLoading ? (
                  <span className="overview-muted">Loading people…</span>
                ) : people.length === 0 ? (
                  <span className="overview-muted">
                    {session.membership?.role === 'owner' && !form.org_id
                      ? 'Invite anyone in the workspace, or pick an organisation first.'
                      : 'No people to invite in this organisation.'}
                  </span>
                ) : (
                  people.map((p) => (
                    <label key={p.id} className="calendar-participant-option">
                      <input
                        type="checkbox"
                        checked={form.participant_ids.includes(p.id)}
                        onChange={(ev) => {
                          const ids = ev.target.checked
                            ? [...form.participant_ids, p.id]
                            : form.participant_ids.filter((id) => id !== p.id);
                          setForm({ ...form, participant_ids: ids });
                        }}
                      />
                      <span>
                        {p.full_name}
                        {p.title ? ` · ${p.title}` : ''}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div className="calendar-modal-actions">
              {modal === 'edit' && (
                <button type="button" className="quiet danger-text" disabled={busy} onClick={deleteEvent}>
                  Delete
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="quiet" disabled={busy} onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
