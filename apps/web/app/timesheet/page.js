'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';

function statusCopy(status) {
  if (!status || status.state === 'none') return 'Not clocked in today';
  if (status.state === 'in') return `Clocked in since ${status.since}`;
  return `Clocked out at ${status.since}`;
}

export default function TimesheetPage() {
  const [token, setToken] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = readStoredSession()?.token ?? null;
    setToken(t);
    if (!t) {
      setLoading(false);
      return;
    }
    api('/attendance/today', t)
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function clock(kind) {
    if (!token) return;
    setBusy(kind);
    setError('');
    try {
      setStatus(await api('/attendance/clock', token, { method: 'POST', body: JSON.stringify({ kind }) }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const isIn = status?.state === 'in';

  return (
    <main className="dashboard-page ts-page">
      <header className="ts-head">
        <h1>Timesheet</h1>
        <p>Clock in when you start and clock out when you finish.</p>
      </header>

      {!token ? <p className="ts-muted">Sign in from Overview to clock in.</p> : null}
      {error ? <p className="ts-error">{error}</p> : null}
      {loading && token ? <p className="ts-muted">Loading…</p> : null}

      {token && status ? (
        <section className="ts-card">
          <div className="ts-status">
            <span className={`ts-dot${isIn ? ' is-in' : ''}`} aria-hidden />
            <div>
              <strong>{statusCopy(status)}</strong>
              <p>
                {status.today}
                {status.hours_today != null ? ` · ${status.hours_today} h recorded` : ''}
                {status.first_in ? ` · first in ${status.first_in}` : ''}
              </p>
            </div>
          </div>

          <div className="ts-actions">
            <button type="button" className="ts-btn" onClick={() => clock('in')} disabled={busy !== null || isIn}>
              {busy === 'in' ? 'Clocking in…' : 'Clock in'}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn-out"
              onClick={() => clock('out')}
              disabled={busy !== null || !isIn}
            >
              {busy === 'out' ? 'Clocking out…' : 'Clock out'}
            </button>
          </div>

          {Array.isArray(status.events) && status.events.length > 0 ? (
            <ul className="ts-events">
              {status.events.map((event, index) => (
                <li key={`${event.kind}-${event.time}-${index}`}>
                  <span>{event.kind === 'in' ? 'In' : 'Out'}</span>
                  <time>{event.time}</time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ts-empty">No punches yet today.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
