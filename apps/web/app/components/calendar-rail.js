'use client';

import { useMemo, useState } from 'react';
import { formatEventTime } from '../lib/dates.js';

function MiniMonth({ today }) {
  const now = new Date(`${today}T12:00:00`);
  const year = now.getFullYear();
  const month = now.getMonth();
  const todayDay = Number(today.slice(8, 10));
  const start = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: start + count }, (_, i) => (i < start ? null : i - start + 1));
  const label = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return (
    <div className="cal rail-cal">
      <div className="cal-head">{label}</div>
      <div className="cal-grid cal-dow">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={`${d}${i}`}>{d}</span>)}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => (
          <span key={i} className={d === todayDay ? 'is-today rose-today' : ''}>{d || ''}</span>
        ))}
      </div>
    </div>
  );
}

function eventOnDay(item, today, tz) {
  if (item.source === 'lock' || item.source === 'task' || item.source === 'milestone') return item.date === today;
  if (!item.starts_at) return false;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(item.starts_at));
  return day === today;
}

export default function CalendarRail({ feed, session, api, onRefresh, setError, orgs, membership }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [icsUrl, setIcsUrl] = useState(null);
  const [form, setForm] = useState({ title: '', starts_at: '', ends_at: '', org_id: '' });

  const today = feed?.today ?? '';
  const tz = feed?.timezone ?? 'Asia/Kolkata';
  const items = feed?.items ?? [];

  const todayItems = useMemo(
    () => items.filter((i) => eventOnDay(i, today, tz)).sort((a, b) => {
      const dayKey = (i) =>
        i.source === 'lock' || i.source === 'task' || i.source === 'milestone' ? i.date : i.starts_at;
      const ta = dayKey(a);
      const tb = dayKey(b);
      return String(ta).localeCompare(String(tb));
    }),
    [items, today, tz],
  );

  async function exportIcs() {
    try {
      const { token } = await api('/calendar/ics-token', session.token);
      setIcsUrl(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001'}/calendar.ics?token=${encodeURIComponent(token)}`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createEvent(e) {
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
        kind: 'meeting',
      };
      if (membership?.role === 'owner') {
        body.org_id = form.org_id || null;
      } else if (membership?.org_id) {
        body.org_id = membership.org_id;
      }
      await api('/calendar/events', session.token, { method: 'POST', body: JSON.stringify(body) });
      setForm({ title: '', starts_at: '', ends_at: '', org_id: '' });
      setOpen(false);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const defaultStart = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 15), 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <aside className="calendar-rail">
      <div className="calendar-rail-head">
        <h2>Calendar</h2>
        <div className="calendar-rail-actions">
          <button
            type="button"
            className="pill dark"
            onClick={() => {
              setOpen(true);
              const defaultOrg = membership?.role === 'owner' ? '' : membership?.org_id ?? '';
              setForm((f) => ({ ...f, starts_at: f.starts_at || defaultStart(), org_id: f.org_id || defaultOrg }));
            }}
          >
            Add event
          </button>
          <button type="button" className="quiet" onClick={() => onRefresh?.()} title="Refresh">
            ↻
          </button>
          <button type="button" className="quiet" onClick={exportIcs} title="ICS export link">
            Export
          </button>
        </div>
      </div>

      {icsUrl && (
        <p className="calendar-ics-hint">
          <a href={icsUrl} target="_blank" rel="noreferrer">Subscribe in calendar app</a>
        </p>
      )}

      <MiniMonth today={today} />

      <section className="calendar-timeline">
        <h3>Today</h3>
        {todayItems.length === 0 ? (
          <p className="overview-muted">Nothing scheduled — days to close and events show here.</p>
        ) : (
          <ul className="calendar-timeline-list">
            {todayItems.map((item) => (
              <li key={item.id} className={`timeline-item source-${item.source}`}>
                <span className="timeline-time">
                  {item.source === 'lock' || item.source === 'task' || item.source === 'milestone'
                    ? 'All day'
                    : formatEventTime(item.starts_at, tz, { allDay: item.all_day })}
                </span>
                <div className="timeline-body">
                  <b>{item.title}</b>
                  {item.org && <small>{item.org}</small>}
                  {item.detail && <small>{item.detail}</small>}
                  {item.source === 'event' && item.created_by_name && (
                    <small>By {item.created_by_name}</small>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {open && (
        <div className="calendar-modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <form className="calendar-modal" onClick={(e) => e.stopPropagation()} onSubmit={createEvent}>
            <h3>Add event</h3>
            <label>
              Title
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} />
            </label>
            <label>
              Starts
              <input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} required />
            </label>
            <label>
              Ends (optional)
              <input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
            </label>
            {membership?.role === 'owner' && orgs?.length > 0 && (
              <label>
                Organisation
                <select
                  value={form.org_id}
                  onChange={(e) => setForm({ ...form, org_id: e.target.value })}
                >
                  <option value="">Personal / workspace</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.short_name ?? o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {membership?.role !== 'owner' && membership?.org_id && (
              <p className="overview-muted calendar-modal-org-hint">
                Organisation: {orgs?.find((o) => o.id === membership.org_id)?.short_name ?? 'Your organisation'}
              </p>
            )}
            <p className="calendar-modal-full-form">
              <a href="/calendar" className="linkish">Full form</a>
              <span className="overview-muted"> — location, notes, and invites</span>
            </p>
            <div className="calendar-modal-actions">
              <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </aside>
  );
}
