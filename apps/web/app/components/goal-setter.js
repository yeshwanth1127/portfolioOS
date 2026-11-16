'use client';

import { useMemo, useRef, useState } from 'react';
import { businessTz, todayISO, addDays } from '../lib/dates.js';

/** Owner "Set goals" screen: pick KPI → pick period → type number → save. Below: every goal, filterable. */

const PERIODS = [
  { value: 'Every day', label: 'Per day', short: 'Daily' },
  { value: 'Every week', label: 'Per week', short: 'Weekly' },
  { value: 'Every month', label: 'Per month', short: 'Monthly' },
  { value: 'Every quarter', label: 'Per quarter', short: 'Quarterly' },
];
const PERIOD_BY_VALUE = Object.fromEntries(PERIODS.map((p) => [p.value, p]));

const SET_WHEN = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Set today' },
  { value: 'week', label: 'Set this week' },
  { value: 'month', label: 'Set this month' },
];

function goalsOf(k) {
  return Array.isArray(k.goals) && k.goals.length ? k.goals : [{ how_often: k.how_often, target: k.target }];
}

function goalFor(k, period) {
  const g = goalsOf(k).find((x) => x.how_often === period);
  return g?.target ?? null;
}

/** Timestamp → YYYY-MM-DD in the business timezone. */
function businessDate(ts) {
  if (!ts) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

function prettySetOn(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: businessTz(), day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(ts),
  );
}

function setWhenMatches(ts, when) {
  if (when === 'any') return true;
  const d = businessDate(ts);
  if (!d) return false;
  const today = todayISO();
  if (when === 'today') return d === today;
  if (when === 'month') return d.slice(0, 7) === today.slice(0, 7);
  // week: Monday → today
  const dow = new Date(`${today}T12:00:00`).getDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  return d >= monday && d <= today;
}

function fmt(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function GoalSetter({ activeOrg, kpis, session, api, setError, onSaved }) {
  const [kpiId, setKpiId] = useState(null);
  const [period, setPeriod] = useState(null);
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [periodFilter, setPeriodFilter] = useState('all');
  const [whenFilter, setWhenFilter] = useState('any');
  const flowRef = useRef(null);

  const kpi = kpis.find((k) => k.id === kpiId) ?? null;
  const current = kpi && period ? goalFor(kpi, period) : null;
  const step = !kpi ? 1 : !period ? 2 : 3;

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return kpis;
    return kpis.filter((k) => k.name.toLowerCase().includes(q) || String(k.code).toLowerCase().includes(q));
  }, [kpis, search]);

  const rows = useMemo(() => {
    const out = [];
    for (const k of kpis) {
      for (const g of goalsOf(k)) {
        out.push({ kpi: k, period: g.how_often, target: g.target, updated_at: g.updated_at ?? null });
      }
    }
    out.sort(
      (a, b) =>
        a.kpi.name.localeCompare(b.kpi.name) ||
        PERIODS.findIndex((p) => p.value === a.period) - PERIODS.findIndex((p) => p.value === b.period),
    );
    return out;
  }, [kpis]);

  const filtered = rows.filter(
    (r) =>
      (periodFilter === 'all' || r.period === periodFilter) &&
      (whenFilter === 'any' || (r.target != null && setWhenMatches(r.updated_at, whenFilter))),
  );
  const missing = rows.filter((r) => r.target == null).length;

  function pickKpi(id) {
    setKpiId(id);
    setPeriod(null);
    setValue('');
    setDone(null);
  }

  function pickPeriod(p) {
    setPeriod(p);
    const existing = goalFor(kpi, p);
    setValue(existing == null ? '' : String(existing));
  }

  function startOver() {
    setKpiId(null);
    setPeriod(null);
    setValue('');
    setSearch('');
  }

  function edit(row) {
    setKpiId(row.kpi.id);
    setPeriod(row.period);
    setValue(row.target == null ? '' : String(row.target));
    setDone(null);
    flowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function save(e) {
    e.preventDefault();
    const target = Number(value);
    if (value === '' || !Number.isFinite(target)) {
      setError('Type a number for the goal.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/kpis/target', session.token, {
        method: 'POST',
        body: JSON.stringify({ kpi_code: kpi.code, target, how_often: period }),
      });
      setDone({ name: kpi.name, target, unit: kpi.unit, period });
      startOver();
      await onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gs">
      <div className="stage-head">
        <div>
          <h1>Set goals</h1>
          <p>{activeOrg?.short_name ?? 'This org'} · tell the team what “good” looks like</p>
        </div>
      </div>

      {/* ---------- Step-by-step flow ---------- */}
      <section className="gs-card" ref={flowRef} aria-label="Set a goal">
        {done ? (
          <div className="gs-done" role="status">
            <span className="gs-done-icon" aria-hidden>✓</span>
            <div>
              <b>Goal saved</b>
              <p>
                {done.name}: {fmt(done.target)} {done.unit} {PERIOD_BY_VALUE[done.period]?.label.toLowerCase()}
              </p>
            </div>
            <button type="button" className="quiet" onClick={() => setDone(null)}>
              Set another goal
            </button>
          </div>
        ) : (
          <ol className="gs-steps">
            {/* Step 1 */}
            <li className={`gs-step${step === 1 ? ' is-active' : ' is-done'}`}>
              <div className="gs-step-head">
                <span className="gs-num">1</span>
                <h2>Choose a KPI</h2>
                {kpi ? (
                  <>
                    <span className="gs-picked">{kpi.name}</span>
                    <button type="button" className="gs-change" onClick={startOver}>Change</button>
                  </>
                ) : null}
              </div>
              {step === 1 ? (
                <div className="gs-step-body">
                  {kpis.length > 8 ? (
                    <input
                      className="gs-search"
                      type="search"
                      placeholder="Search KPIs…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      autoFocus
                    />
                  ) : null}
                  {kpis.length === 0 ? (
                    <p className="gs-empty">
                      No KPIs yet. <a className="linkish" href="/?tab=kpis">Add a KPI first</a>.
                    </p>
                  ) : (
                    <div className="gs-options">
                      {matches.map((k) => (
                        <button key={k.id} type="button" className="gs-option" onClick={() => pickKpi(k.id)}>
                          <b>{k.name}</b>
                          <span>{k.unit || 'number'}</span>
                        </button>
                      ))}
                      {matches.length === 0 ? <p className="gs-empty">No KPI matches “{search}”.</p> : null}
                    </div>
                  )}
                  {kpis.length ? (
                    <p className="gs-hint">
                      KPI not listed? <a className="linkish" href="/?tab=kpis">Add it on the KPIs page</a>.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>

            {/* Step 2 */}
            <li className={`gs-step${step === 2 ? ' is-active' : step > 2 ? ' is-done' : ''}`}>
              <div className="gs-step-head">
                <span className="gs-num">2</span>
                <h2>Pick the period</h2>
                {period ? (
                  <>
                    <span className="gs-picked">{PERIOD_BY_VALUE[period]?.label}</span>
                    <button type="button" className="gs-change" onClick={() => setPeriod(null)}>Change</button>
                  </>
                ) : null}
              </div>
              {step === 2 ? (
                <div className="gs-step-body">
                  <div className="gs-periods">
                    {PERIODS.map((p) => {
                      const g = goalFor(kpi, p.value);
                      return (
                        <button key={p.value} type="button" className="gs-option" onClick={() => pickPeriod(p.value)}>
                          <b>{p.label}</b>
                          <span>{g == null ? 'No goal yet' : `Now: ${fmt(g)} ${kpi.unit || ''}`}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </li>

            {/* Step 3 */}
            <li className={`gs-step${step === 3 ? ' is-active' : ''}`}>
              <div className="gs-step-head">
                <span className="gs-num">3</span>
                <h2>Enter the goal</h2>
              </div>
              {step === 3 ? (
                <form className="gs-step-body" onSubmit={save}>
                  <label className="gs-value">
                    <span className="sr-only">Goal</span>
                    <input
                      type="number"
                      step="any"
                      inputMode="decimal"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="0"
                      autoFocus
                      required
                    />
                    <em>
                      {kpi.unit || ''} {PERIOD_BY_VALUE[period]?.label.toLowerCase()}
                    </em>
                  </label>
                  <p className="gs-hint">
                    {kpi.direction === 'lower_is_better' ? 'Lower is better for this KPI. ' : ''}
                    {current != null ? `Current goal is ${fmt(current)} — saving replaces it.` : 'No goal set yet for this period.'}
                  </p>
                  <button className="primary gs-save" type="submit" disabled={busy || value === ''}>
                    {busy ? 'Saving…' : 'Save goal'}
                  </button>
                </form>
              ) : null}
            </li>
          </ol>
        )}
      </section>

      {/* ---------- All goals ---------- */}
      <section className="gs-card" aria-label="All goals">
        <div className="gs-list-head">
          <h2>All goals</h2>
          {missing ? <span className="tag warn">{missing} without a goal</span> : null}
        </div>

        <div className="gs-filters">
          <div className="gs-seg" role="tablist" aria-label="Filter by period">
            {[{ value: 'all', short: 'All' }, ...PERIODS].map((p) => (
              <button
                key={p.value}
                type="button"
                role="tab"
                aria-selected={periodFilter === p.value}
                className={periodFilter === p.value ? 'is-on' : ''}
                onClick={() => setPeriodFilter(p.value)}
              >
                {p.short}
              </button>
            ))}
          </div>
          <select value={whenFilter} onChange={(e) => setWhenFilter(e.target.value)} aria-label="Filter by when set">
            {SET_WHEN.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="gs-empty">No goals match these filters.</p>
        ) : (
          <ul className="gs-rows">
            {filtered.map((r) => (
              <li key={`${r.kpi.id}:${r.period}`} className={`gs-row${r.target == null ? ' is-missing' : ''}`}>
                <div className="gs-row-name">
                  <b>{r.kpi.name}</b>
                  <span>{PERIOD_BY_VALUE[r.period]?.short ?? r.period}</span>
                </div>
                <div className="gs-row-goal">
                  {r.target == null ? (
                    <span className="tag warn">No goal</span>
                  ) : (
                    <>
                      <strong>{fmt(r.target)}</strong> <em>{r.kpi.unit}</em>
                    </>
                  )}
                </div>
                <div className="gs-row-when">{r.target == null ? '' : `Set ${prettySetOn(r.updated_at)}`}</div>
                <button type="button" className="gs-change" onClick={() => edit(r)}>
                  {r.target == null ? 'Set' : 'Edit'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
