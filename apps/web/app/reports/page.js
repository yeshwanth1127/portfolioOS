'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import NavIcon from '../components/nav-icon';
import { api } from '../lib/api.js';
import { STATUS_TEXT, periodLabel, periodPresets, timeAgo } from '../lib/report-format.js';
import { readStoredSession } from '../lib/session.js';

export default function ReportsPage() {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [options, setOptions] = useState(null);
  const [lists, setLists] = useState({ mine: [], shared: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('mine');

  const [type, setType] = useState('');
  const [preset, setPreset] = useState('this_week');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [scope, setScope] = useState('');
  const [focus, setFocus] = useState('');

  const loadLists = useCallback(async (t) => {
    if (!t) return;
    const out = await api('/reports/generated', t).catch(() => null);
    if (out) setLists(out);
  }, []);

  useEffect(() => {
    const t = readStoredSession()?.token ?? null;
    setToken(t);
    if (!t) return;
    api('/reports/options', t)
      .then((o) => {
        setOptions(o);
        // Members land on their own work report; leads on the first team report.
        setType((o.role === 'member' ? o.types.find((x) => x.personal) : o.types.find((x) => !x.personal))?.id ?? o.types[0]?.id ?? '');
        setCustom({ from: o.today, to: o.today });
        const first = o.scopes.find((s) => s.kind === o.default_scope) ?? o.scopes[0];
        setScope(first ? `${first.kind}:${first.ref ?? ''}` : '');
      })
      .catch((e) => setError(e.message));
    loadLists(t);
  }, [loadLists]);

  // Keep the list fresh while something is generating.
  const pending = lists.mine.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!pending || !token) return undefined;
    const id = setInterval(() => loadLists(token), 2500);
    return () => clearInterval(id);
  }, [pending, token, loadLists]);

  const presets = useMemo(() => periodPresets(options?.today), [options?.today]);
  const period = preset === 'custom' ? custom : presets.find((p) => p.id === preset) ?? {};
  const selectedType = options?.types.find((t) => t.id === type);
  const scopeChoices = useMemo(() => {
    if (!options) return [];
    const base = selectedType?.personal ? options.scopes.filter((s) => s.kind === 'me') : options.scopes;
    return base;
  }, [options, selectedType]);
  const showScope = Boolean(options) && (scopeChoices.length > 1 || options.people.length > 0);

  async function generate(e) {
    e.preventDefault();
    if (!token || !type) return;
    setBusy(true);
    setError('');
    const [scope_kind, scope_ref] = scope.split(':');
    try {
      const out = await api('/reports/generated', token, {
        method: 'POST',
        body: JSON.stringify({
          report_type: type,
          from: period.from,
          to: period.to,
          scope_kind,
          scope_ref: scope_ref || null,
          instructions: focus.trim() || undefined,
        }),
      });
      router.push(`/reports/${out.report.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const list = tab === 'shared' ? lists.shared : lists.mine;

  return (
    <main className="dashboard-page rp-page">
      <header className="rp-head">
        <div>
          <h1>Reports</h1>
          <p>Pick what you need and the period. Figures come straight from what was recorded in Orbit.</p>
        </div>
      </header>

      {!token ? <p className="rp-muted">Sign in to create reports.</p> : null}
      {error ? <p className="rp-error">{error}</p> : null}

      {options ? (
        <form className="rp-card rp-builder" onSubmit={generate}>
          <div className="rp-field">
            <span className="rp-label">Report</span>
            <div className="rp-types">
              {options.types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`rp-type${type === t.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setType(t.id);
                    if (t.personal) {
                      const me = options.scopes.find((s) => s.kind === 'me');
                      if (me) setScope(`me:${me.ref ?? ''}`);
                    }
                  }}
                  aria-pressed={type === t.id}
                >
                  <NavIcon name={t.icon} />
                  <span className="rp-type-text">
                    <strong>{t.label}</strong>
                    <small>{t.description}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rp-field">
            <span className="rp-label">Period</span>
            <div className="rp-chips" role="radiogroup" aria-label="Period">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.id}
                  className={`rp-chip${preset === p.id ? ' is-active' : ''}`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' ? (
              <div className="rp-dates">
                <input type="date" value={custom.from} max={options.today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="From" />
                <span>to</span>
                <input type="date" value={custom.to} max={options.today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="To" />
              </div>
            ) : (
              <p className="rp-hint">{periodLabel(period.from, period.to)}</p>
            )}
          </div>

          {showScope ? (
            <div className="rp-field">
              <label className="rp-label" htmlFor="rp-scope">Covering</label>
              <select id="rp-scope" className="rp-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                {scopeChoices.map((s) => (
                  <option key={`${s.kind}:${s.ref ?? ''}`} value={`${s.kind}:${s.ref ?? ''}`}>
                    {s.label}
                  </option>
                ))}
                {options.people.length ? (
                  <optgroup label="One person">
                    {options.people.map((p) => (
                      <option key={p.ref} value={`person:${p.ref}`}>
                        {p.label}{p.group ? ` · ${p.group}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>
          ) : null}

          <div className="rp-field">
            <label className="rp-label" htmlFor="rp-focus">Anything to focus on? <em>optional</em></label>
            <input
              id="rp-focus"
              className="rp-input"
              value={focus}
              maxLength={300}
              placeholder="e.g. Why did reporting drop on Friday?"
              onChange={(e) => setFocus(e.target.value)}
            />
          </div>

          <div className="rp-actions">
            <button type="submit" className="rp-btn" disabled={busy || !type || !period.from || !period.to}>
              {busy ? 'Starting…' : 'Generate report'}
            </button>
          </div>
        </form>
      ) : token && !error ? (
        <div className="rp-card rp-skeleton" aria-busy="true" />
      ) : null}

      {token ? (
        <section className="rp-history">
          <div className="rp-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'is-active' : ''} onClick={() => setTab('mine')}>
              Your reports
            </button>
            {lists.shared.length ? (
              <button type="button" role="tab" aria-selected={tab === 'shared'} className={tab === 'shared' ? 'is-active' : ''} onClick={() => setTab('shared')}>
                Sent to you <span className="rp-count">{lists.shared.length}</span>
              </button>
            ) : null}
          </div>
          {list.length ? (
            <ul className="rp-list">
              {list.map((r) => (
                <li key={r.id}>
                  <Link href={`/reports/${r.id}`} className="rp-row">
                    <span className="rp-row-main">
                      <strong>{r.title}</strong>
                      <small>
                        {periodLabel(r.period_from, r.period_to)}
                        {tab === 'shared' ? ` · from ${r.requested_by_name}` : ''}
                        {tab === 'mine' && r.submitted_at ? ' · sent' : ''}
                      </small>
                    </span>
                    <span className={`rp-pill is-${r.status}`}>{STATUS_TEXT[r.status] ?? r.status}</span>
                    <span className="rp-row-time">{timeAgo(tab === 'shared' ? r.submitted_at : r.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rp-muted rp-empty-list">{tab === 'shared' ? 'Nothing sent to you yet.' : 'No reports yet. Your first one is a click away.'}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
