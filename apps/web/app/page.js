'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

const DEMO_PW = process.env.NEXT_PUBLIC_DEMO_PASSWORD || 'password123';
const HIDE_DEMO_LOGINS = process.env.NEXT_PUBLIC_HIDE_DEMO_LOGINS === '1';

const ACCOUNTS = [
  ['Thyagu Sir', 'Owner', 'owner@portfolio.local', DEMO_PW],
  ['Mrs. Indhumathi', 'TMS manager', 'indhumathi@portfolio.local', DEMO_PW],
  ['Karthik', 'TMS team lead', 'karthik@portfolio.local', DEMO_PW],
  ['Mr. Raj Kumar', 'Unreal manager', 'rajkumar@portfolio.local', DEMO_PW],
  ['Ventak Raja', 'Sonastar3Dx manager', 'ventakraja@portfolio.local', DEMO_PW],
  ['Anju Raj', 'PATS manager', 'anjuraj@portfolio.local', DEMO_PW],
  ['Nagaraj', 'SAI manager', 'nagaraj@portfolio.local', DEMO_PW],
  ['Abhinav', 'Communications manager', 'abhinav@portfolio.local', DEMO_PW],
  ['Venugopal', 'SCALE manager', 'venugopal@portfolio.local', DEMO_PW],
  ['Sheelan Mam', 'SCALE vice manager', 'sheelan@portfolio.local', DEMO_PW],
  ['Ms. Harini', 'TMS member', 'harini@portfolio.local', DEMO_PW],
  ['Sasikumar', 'SAI member', 'sasikumar@portfolio.local', DEMO_PW],
];

const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  vice_manager: 'Vice manager',
  team_lead: 'Team lead',
  member: 'Member',
};

function roleLabel(role) {
  return ROLE_LABELS[role] ?? role ?? '—';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const TOOL_LABELS = {
  check_readiness: 'Check readiness',
  check_day: 'Check the day',
  show_kpi: 'Show KPI',
  list_kpis: 'List KPIs',
  list_waiting: 'Waiting',
  list_off_track: 'Off track',
  who_owns: 'Who owns it',
  find_person: 'Find person',
  list_escalations: 'Escalations',
  record_number: 'Record number',
  set_target: 'Set goal',
  decide_escalation: 'Decide',
};

const HOW_OFTEN_OPTIONS = ['Every day', 'Every week', 'Every month', 'Every quarter'];
const CADENCE_LABEL = { 'Every day': 'Daily', 'Every week': 'Weekly', 'Every month': 'Monthly', 'Every quarter': 'Quarterly' };

function kpiGoals(k) {
  return Array.isArray(k.goals) && k.goals.length ? k.goals : [{ how_often: k.how_often, target: k.target }];
}
function trackedLabel(k) {
  return kpiGoals(k).map((g) => CADENCE_LABEL[g.how_often] ?? g.how_often).join(' · ');
}
function goalFor(k, howOften) {
  const g = kpiGoals(k).find((x) => x.how_often === howOften);
  return g ? g.target : undefined; // undefined = not tracked at this cadence
}

/** How often (dropdown) + Goal cells for one KPI row. The dropdown picks the cadence; the goal follows it. */
function KpiCadenceCells({ k, canEdit, session, api, setError, onSaved }) {
  const [cadence, setCadence] = useState(k.how_often);
  const goal = goalFor(k, cadence);
  const [draft, setDraft] = useState(goal == null ? '' : String(goal));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const g = goalFor(k, cadence);
    setDraft(g == null ? '' : String(g));
  }, [k, cadence]);

  async function save() {
    const current = goalFor(k, cadence);
    const trimmed = draft.trim();
    if (trimmed === '' && current === undefined) return;
    if (trimmed !== '' && current != null && Number(trimmed) === Number(current)) return;
    setBusy(true);
    try {
      if (trimmed === '') {
        // Clearing the goal stops tracking this cadence.
        const rest = kpiGoals(k).filter((g) => g.how_often !== cadence);
        if (!rest.length) throw new Error('A KPI needs at least one cadence with a goal.');
        await api(`/kpis/${k.id}`, session.token, { method: 'PATCH', body: JSON.stringify({ goals: rest }) });
      } else {
        const target = Number(trimmed);
        if (!Number.isFinite(target)) throw new Error('Goal must be a number.');
        await api('/kpis/target', session.token, {
          method: 'POST',
          body: JSON.stringify({ kpi_code: k.code, how_often: cadence, target }),
        });
      }
      await onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <td>
        <select className="cadence-select" value={cadence} onChange={(e) => setCadence(e.target.value)}>
          {HOW_OFTEN_OPTIONS.map((o) => {
            const g = goalFor(k, o);
            return (
              <option key={o} value={o}>
                {o}{g === undefined ? '' : ' ✓'}
              </option>
            );
          })}
        </select>
      </td>
      <td>
        {canEdit ? (
          <div className="cadence-goal">
            <input
              type="number"
              step="any"
              placeholder="Not tracked"
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            />
            <em>{k.unit}</em>
          </div>
        ) : goal === undefined ? (
          <span className="tag">Not tracked</span>
        ) : goal == null ? (
          <span className="tag warn">Not set</span>
        ) : (
          `${goal} ${k.unit}`
        )}
      </td>
    </>
  );
}

function isDailyKpi(k) {
  return /day/i.test(k.how_often || '');
}
function isMonthlyKpi(k) {
  return /month/i.test(k.how_often || '');
}
function isWeeklyKpi(k) {
  return /week/i.test(k.how_often || '');
}
function isQuarterlyKpi(k) {
  return /quarter/i.test(k.how_often || '');
}

function slugifyMeasureCode(orgSlug, name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'measure';
  return `${orgSlug}.${base}`;
}

function prettyDate() {
  return new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function submissionLabel(state) {
  if (state === 'submitted') return { text: 'Waiting', tone: 'warn' };
  if (state === 'validated') return { text: 'Accepted', tone: 'ok' };
  if (state === 'rejected') return { text: 'Rejected', tone: 'danger' };
  if (state === 'locked') return { text: 'Locked', tone: 'ok' };
  if (state === 'amended') return { text: 'Amended', tone: 'warn' };
  return { text: state || '—', tone: '' };
}

const SESSION_KEY = 'portfolio-os-session';
const ORG_KEY = 'portfolio-os-org';

function readStoredSession() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredSession(next) {
  if (typeof window === 'undefined') return;
  if (next?.token) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
}

async function api(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? 'Request failed');
  return data;
}

/** Session and org come from localStorage, so render only in the browser (avoids hydration mismatch). */
export default function Home() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <PortfolioApp /> : null;
}

function PortfolioApp() {
  const [email, setEmail] = useState(HIDE_DEMO_LOGINS ? '' : 'owner@portfolio.local');
  const [password, setPassword] = useState(HIDE_DEMO_LOGINS ? '' : DEMO_PW);
  const [error, setError] = useState('');
  const [session, setSession] = useState(readStoredSession);
  const [orgs, setOrgs] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [orgSlug, setOrgSlug] = useState(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(ORG_KEY) || readStoredSession()?.membership?.org_slug || null;
  });
  const [tab, setTab] = useState('overview');
  const [kpis, setKpis] = useState([]);
  const [people, setPeople] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [draft, setDraft] = useState({ code: '', value: '' });
  const [orgForm, setOrgForm] = useState(null);
  const [kpiForm, setKpiForm] = useState(null);
  const [editingKpi, setEditingKpi] = useState(null);
  const [personForm, setPersonForm] = useState(null);
  const [editingPerson, setEditingPerson] = useState(null);
  const [editingSub, setEditingSub] = useState(null);
  const [period, setPeriod] = useState('day');
  const [focusKpi, setFocusKpi] = useState(null);
  const [chat, setChat] = useState([]);
  const [chatSessionId, setChatSessionId] = useState(null);
  const [chatSessions, setChatSessions] = useState([]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [thinkPhase, setThinkPhase] = useState(0);
  const [myPhone, setMyPhone] = useState('');
  const chatEndRef = useRef(null);
  const chatScrollRef = useRef(null);

  const membership = session?.membership;
  const activeOrg = orgs.find((o) => o.slug === orgSlug) ?? null;

  function clearSession() {
    writeStoredSession(null);
    if (typeof window !== 'undefined') localStorage.removeItem(ORG_KEY);
    setSession(null);
    setOrgSlug(null);
    setOrgs([]);
    setReadiness(null);
  }

  async function login(e) {
    e.preventDefault();
    setError('');
    try {
      const data = await api('/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      writeStoredSession(data);
      setSession(data);
      setMyPhone(data.membership.phone_e164 ?? '');
      const nextOrg = data.membership.org_slug ?? null;
      setOrgSlug(nextOrg);
      if (typeof window !== 'undefined') {
        if (nextOrg) localStorage.setItem(ORG_KEY, nextOrg);
        else localStorage.removeItem(ORG_KEY);
      }
      setOrgForm(null);
      setTab(
        data.membership.role === 'owner'
          ? 'today'
          : ['member', 'team_lead'].includes(data.membership.role)
            ? 'today'
            : 'overview',
      );
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    writeStoredSession(session);
  }, [session]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (orgSlug) localStorage.setItem(ORG_KEY, orgSlug);
    else localStorage.removeItem(ORG_KEY);
  }, [orgSlug]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const orgData = await api('/orgs', session.token);
        setOrgs(orgData.orgs ?? []);
        if (session.membership.role === 'owner') {
          setReadiness(await api('/readiness', session.token));
        }
        if (!session.membership.org_slug && orgData.orgs?.[0]) {
          setOrgSlug((current) => current ?? orgData.orgs[0].slug);
        }
        setMyPhone(session.membership.phone_e164 ?? '');
      } catch (err) {
        if (/invalid|expired|unauthor|forbidden|jwt/i.test(err.message)) {
          clearSession();
          setError('Session expired. Sign in again.');
        } else {
          setError(err.message);
        }
      }
    })();
  }, [session]);

  useEffect(() => {
    if (!session || !orgSlug) return;
    (async () => {
      const [k, p, s] = await Promise.all([
        api(`/orgs/${orgSlug}/kpis`, session.token),
        api(`/orgs/${orgSlug}/people`, session.token),
        api(`/submissions?org=${orgSlug}&date=${todayISO()}`, session.token),
      ]);
      setKpis(k.kpis ?? []);
      setPeople(p.people ?? []);
      setSubmissions(s.submissions ?? []);
    })().catch((err) => setError(err.message));
  }, [session, orgSlug]);

  async function loadChatSession(sessionId, token) {
    const path = sessionId ? `/agent/chat?session_id=${encodeURIComponent(sessionId)}` : '/agent/chat';
    const data = await api(path, token);
    setChatSessionId(data.session_id ?? null);
    setChat(data.messages ?? []);
    return data;
  }

  async function refreshChatHistory(token) {
    const data = await api('/agent/chat/sessions', token);
    setChatSessions(data.sessions ?? []);
  }

  useEffect(() => {
    if (!session || session.membership.role !== 'owner') return;
    loadChatSession(null, session.token)
      .then(() => refreshChatHistory(session.token))
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!chatBusy) {
      setThinkPhase(0);
      return undefined;
    }
    setThinkPhase(1);
    const t1 = setTimeout(() => setThinkPhase(2), 700);
    const t2 = setTimeout(() => setThinkPhase(3), 1800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [chatBusy]);

  useEffect(() => {
    const el = chatEndRef.current;
    if (!el || tab !== 'agent') return;
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat, chatBusy, tab]);

  const reportIds = useMemo(() => {
    if (!membership || membership.role !== 'team_lead') return new Set();
    return new Set(people.filter((p) => p.parent_id === membership.id).map((p) => p.id));
  }, [people, membership]);

  const visibleKpis = useMemo(() => {
    if (!membership) return [];
    if (membership.role === 'member') {
      return kpis.filter((k) => k.owner_id === membership.id);
    }
    if (membership.role === 'team_lead') {
      return kpis.filter(
        (k) => k.owner_id === membership.id || reportIds.has(k.owner_id),
      );
    }
    return kpis;
  }, [kpis, membership, reportIds]);

  const canManage = membership && ['owner', 'manager', 'vice_manager'].includes(membership.role);
  const canEditKpis = membership?.role === 'owner';
  const canReview = membership && ['owner', 'manager', 'vice_manager', 'team_lead'].includes(membership.role);
  const canLock = membership && ['owner', 'manager'].includes(membership.role);
  const assignableRoles = membership?.role === 'owner'
    ? ['member', 'team_lead', 'vice_manager', 'manager']
    : ['member', 'vice_manager'];
  const dailyKpis = useMemo(() => visibleKpis.filter(isDailyKpi), [visibleKpis]);
  const monthlyKpis = useMemo(() => visibleKpis.filter(isMonthlyKpi), [visibleKpis]);
  const weeklyKpis = useMemo(() => visibleKpis.filter(isWeeklyKpi), [visibleKpis]);
  const quarterlyKpis = useMemo(() => visibleKpis.filter(isQuarterlyKpi), [visibleKpis]);
  const dialKpis = useMemo(() => {
    if (period === 'day') return dailyKpis.length ? dailyKpis : visibleKpis;
    if (period === 'week') return weeklyKpis.length ? weeklyKpis : visibleKpis;
    return monthlyKpis.length ? monthlyKpis : visibleKpis;
  }, [visibleKpis, dailyKpis, weeklyKpis, monthlyKpis, period]);
  const submittedCodes = useMemo(() => new Set(submissions.map((s) => s.kpi_code)), [submissions]);
  const pendingTodayKpis = useMemo(
    () => dailyKpis.filter((k) => !submittedCodes.has(k.code)),
    [dailyKpis, submittedCodes],
  );
  const pendingMonthlyKpis = useMemo(
    () => monthlyKpis.filter((k) => !submittedCodes.has(k.code)),
    [monthlyKpis, submittedCodes],
  );
  const waitingReview = useMemo(
    () => submissions.filter((s) => s.state === 'submitted'),
    [submissions],
  );
  const todayDone = dailyKpis.filter((k) => submittedCodes.has(k.code)).length;
  const todayTotal = dailyKpis.length;
  const todayPct = todayTotal ? Math.round((todayDone / todayTotal) * 100) : 0;
  const withTarget = visibleKpis.filter((k) => k.target != null).length;
  const targetPct = visibleKpis.length ? Math.round((withTarget / visibleKpis.length) * 100) : 0;
  const sentPct = dailyKpis.length
    ? Math.round((todayDone / dailyKpis.length) * 100)
    : 0;
  const orgReadiness = {
    unnamed: readiness?.unnamed_by_org?.find((r) => r.slug === orgSlug)?.c ?? people.filter((p) => p.state === 'pending_name').length,
    missing: readiness?.null_targets_by_org?.find((r) => r.slug === orgSlug)?.c ?? kpis.filter((k) => k.target == null).length,
  };

  async function reloadOrgBits() {
    const [k, p, s, orgData] = await Promise.all([
      api(`/orgs/${orgSlug}/kpis`, session.token),
      api(`/orgs/${orgSlug}/people`, session.token),
      api(`/submissions?org=${orgSlug}&date=${todayISO()}`, session.token),
      api('/orgs', session.token),
    ]);
    setKpis(k.kpis ?? []);
    setPeople(p.people ?? []);
    setSubmissions(s.submissions ?? []);
    setOrgs(orgData.orgs ?? []);
  }

  async function refreshToday() {
    const s = await api(`/submissions?org=${orgSlug}&date=${todayISO()}`, session.token);
    setSubmissions(s.submissions ?? []);
  }

  async function submitValue(e) {
    e.preventDefault();
    if (!draft.code || draft.value === '') return;
    setError('');
    try {
      await api('/submissions', session.token, {
        method: 'POST',
        body: JSON.stringify({ kpi_code: draft.code, value: Number(draft.value), period_date: todayISO() }),
      });
      const remaining = pendingTodayKpis.filter((k) => k.code !== draft.code);
      setDraft({ code: remaining[0]?.code ?? '', value: '' });
      await refreshToday();
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitKpiValue(code, value) {
    if (value === '' || value == null) return;
    setError('');
    try {
      await api('/submissions', session.token, {
        method: 'POST',
        body: JSON.stringify({ kpi_code: code, value: Number(value), period_date: todayISO() }),
      });
      await refreshToday();
    } catch (err) {
      setError(err.message);
    }
  }

  async function validate(id, accept) {
    await api(`/submissions/${id}/validate`, session.token, {
      method: 'POST',
      body: JSON.stringify({ accept, reason: accept ? null : 'Needs a correction' }),
    });
    await refreshToday();
  }

  async function signoff() {
    await api(`/orgs/${orgSlug}/signoff`, session.token, {
      method: 'POST',
      body: JSON.stringify({ period_date: todayISO() }),
    });
    await refreshToday();
  }

  if (!session) {
    return (
      <div className="app">
        <div className="board">
        <header className="topbar">
          <div className="mark"><span className="badge">P</span> Portfolio</div>
        </header>
        <div className="login">
          <div className="login-copy">
            <h1>See the day across every organisation.</h1>
            <p>One portfolio for Thyagu Sir. Each manager runs their organisation; team leads own a squad.</p>
          </div>
          <form className="login-form" onSubmit={login}>
            <h2>Sign in</h2>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <p className="err">{error}</p>
            <button className="primary" type="submit">Sign in</button>
            {!HIDE_DEMO_LOGINS && <p className="account-label">Continue as</p>}
            {!HIDE_DEMO_LOGINS && <div className="accounts">
              {ACCOUNTS.map(([name, role, mail, pw]) => (
                <button
                  key={mail}
                  type="button"
                  onClick={() => {
                    setEmail(mail);
                    setPassword(pw);
                  }}
                >
                  <span>{name}</span>
                  <small>{role}</small>
                </button>
              ))}
            </div>}
          </form>
        </div>
        </div>
      </div>
    );
  }

  const nav = membership.role === 'owner'
    ? [
      ['overview', 'Overview'],
      ['today', 'Set goals'],
      ['kpis', 'KPIs'],
      ['team', 'Team'],
      ['account', 'Account'],
      ['agent', 'Agent'],
      ['settings', 'Settings'],
    ]
    : [
      ['overview', 'Overview'],
      ['kpis', 'KPIs'],
      ['team', 'Team'],
      ['today', 'Today'],
      ['account', 'Account'],
    ];

  const firstName = (membership.full_name || '').split(' ')[0];
  const openItems = orgReadiness.unnamed + orgReadiness.missing;

  return (
    <div className="app">
      <div className={`board${tab === 'agent' ? ' board-agent' : ''}`}>
        <header className="board-nav">
          <button className="menu" type="button" onClick={() => setTab('overview')} aria-label="Overview">
            <span /><span /><span />
          </button>
          <nav className="tabs">
            {nav.map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? 'on' : ''}
                type="button"
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="nav-right">
            <select
              className="orgpill"
              value={orgSlug ?? ''}
              onChange={(e) => {
                setOrgSlug(e.target.value);
                setOrgForm(null);
                setKpiForm(null);
                setEditingKpi(null);
                setPersonForm(null);
                setEditingPerson(null);
                setFocusKpi(null);
              }}
            >
              {orgs.map((org) => (
                <option key={org.id} value={org.slug}>{org.short_name}</option>
              ))}
            </select>
            <details className="user">
              <summary>{firstName}</summary>
              <button type="button" onClick={() => setTab('account')}>Account</button>
              <button type="button" onClick={clearSession}>Sign out</button>
            </details>
          </div>
        </header>
        {error && <p className="err banner">{error}</p>}

        {orgSlug && tab === 'overview' && activeOrg && (
          <>
            <section className="hero">
              <div className="period">
                <button type="button" className={period === 'day' ? 'on' : ''} onClick={() => setPeriod('day')}>Day</button>
                <button type="button" className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>Week</button>
                <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>Month</button>
              </div>
              <div className="greet">
                <h1>{greeting(membership.full_name)}</h1>
                <p>{longDate()}</p>
              </div>
              <div className="stat"><span>KPIs</span><strong>{visibleKpis.length}</strong></div>
              <div className="stat"><span>With a goal</span><strong>{withTarget}</strong></div>
              <div className="stat"><span>People</span><strong>{people.length}</strong></div>
              <div className="donutrow">
                <Donut pct={targetPct} color="#234e86" />
                <Donut pct={Math.min(100, sentPct)} color="#8fbfb6" />
                <div className="stat">
                  <span>Still open</span>
                  <strong>{openItems}</strong>
                </div>
              </div>
            </section>

            {canEditKpis ? (
              <section className="owner-goals-board">
                <OwnerGoalSetter
                  title="Set daily goals"
                  hint={`For ${activeOrg.short_name}. Type each daily goal, then save once.`}
                  kpis={dailyKpis}
                  emphasize
                  session={session}
                  api={api}
                  setError={setError}
                  onSaved={reloadOrgBits}
                />
                <div className="owner-goals-side">
                  <OwnerGoalSetter
                    title="Weekly goals"
                    hint="Optional — set when needed."
                    kpis={weeklyKpis}
                    session={session}
                    api={api}
                    setError={setError}
                    onSaved={reloadOrgBits}
                  />
                  <OwnerGoalSetter
                    title="Monthly goals"
                    hint="Optional — set when needed."
                    kpis={monthlyKpis}
                    session={session}
                    api={api}
                    setError={setError}
                    onSaved={reloadOrgBits}
                  />
                </div>
              </section>
            ) : canManage ? (
              <section className="manage-board">
                <div className="manage-panel">
                  <div className="today-section-head">
                    <h2>Goals set by owner</h2>
                    <span>{visibleKpis.length}</span>
                  </div>
                  <p className="muted-line">Register for {activeOrg.short_name}. Goals come from Thyagu; assign owners on the KPIs tab.</p>
                  {visibleKpis.length === 0 ? (
                    <div className="today-empty">No KPIs in this organisation yet.</div>
                  ) : (
                    <ul className="goal-list">
                      {visibleKpis.map((k) => (
                        <li key={k.id} className="goal-row">
                          <div>
                            <b>{k.name}</b>
                            <span>{k.code} · {trackedLabel(k)}{k.owner_name ? ` · ${k.owner_name}` : ''}</span>
                          </div>
                          <div className="goal-target">
                            {k.target == null
                              ? <span className="tag warn">No goal</span>
                              : <><strong>{k.target}</strong> <em>{k.unit}</em></>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="manage-panel">
                  <div className="today-section-head">
                    <h2>Today&apos;s numbers</h2>
                    <span>{todayDone}/{todayTotal || 0}</span>
                  </div>
                  <p className="muted-line">Daily measures due today. Enter the value against the goal.</p>
                  {dailyKpis.length === 0 ? (
                    <div className="today-empty">No daily KPIs in this organisation.</div>
                  ) : (
                    <ul className="today-list">
                      {dailyKpis.map((k) => (
                        submittedCodes.has(k.code) ? (
                          <li key={k.id} className="today-row is-sent">
                            <div className="today-row-main">
                              <div className="today-row-title"><b>{k.name}</b><span>{k.code}</span></div>
                              <div className="today-row-goal">
                                {k.target == null ? <span className="tag warn">No goal</span> : <span>Goal <strong>{k.target}</strong> {k.unit}</span>}
                              </div>
                              <span className="tag ok">Sent</span>
                            </div>
                          </li>
                        ) : (
                          <PendingKpiRow key={k.id} kpi={k} onSubmit={submitKpiValue} />
                        )
                      ))}
                    </ul>
                  )}
                </div>

                <div className="manage-panel">
                  <div className="today-section-head">
                    <h2>Monthly numbers</h2>
                    <span>{monthlyKpis.filter((k) => submittedCodes.has(k.code)).length}/{monthlyKpis.length || 0}</span>
                  </div>
                  <p className="muted-line">Monthly measures. Enter this period&apos;s value against the goal.</p>
                  {monthlyKpis.length === 0 ? (
                    <div className="today-empty">No monthly KPIs in this organisation.</div>
                  ) : (
                    <ul className="today-list">
                      {monthlyKpis.map((k) => (
                        submittedCodes.has(k.code) ? (
                          <li key={k.id} className="today-row is-sent">
                            <div className="today-row-main">
                              <div className="today-row-title"><b>{k.name}</b><span>{k.code}</span></div>
                              <div className="today-row-goal">
                                {k.target == null ? <span className="tag warn">No goal</span> : <span>Goal <strong>{k.target}</strong> {k.unit}</span>}
                              </div>
                              <span className="tag ok">Sent</span>
                            </div>
                          </li>
                        ) : (
                          <PendingKpiRow key={k.id} kpi={k} onSubmit={submitKpiValue} />
                        )
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            ) : (
              <section className="workspace">
                <div className="entry">
                  <div className="kicker">Record a number</div>
                  <form onSubmit={submitValue}>
                    <label>
                      Measure
                      <select className="linefield" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} required>
                        <option value="">Choose</option>
                        {visibleKpis.map((k) => <option key={k.id} value={k.code}>{k.name}</option>)}
                      </select>
                    </label>
                    <label>
                      Value
                      <input className="linefield" type="number" step="any" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} required />
                    </label>
                    <button className="ghost" type="submit">Save number</button>
                  </form>
                </div>
                <div className="dial-wrap">
                  <KpiDial
                    kpis={dialKpis}
                    submitted={submittedCodes}
                    focus={focusKpi}
                    onFocus={setFocusKpi}
                  />
                  <div className="legend">
                    <span><i className="swatch navy" /> With a goal</span>
                    <span><i className="swatch coral" /> No goal</span>
                    <span><i className="swatch teal" /> Sent today</span>
                  </div>
                </div>
                <aside className="side">
                  <div className="side-head">Team</div>
                  <div className="teamlist">
                    {people.map((p, i) => (
                      <div className="person" key={p.id}>
                        <i style={{ background: ROLE_COLORS[i % ROLE_COLORS.length] }} />
                        <div>
                          <b>{p.full_name}</b>
                          <small>{p.state === 'pending_name' ? 'Name pending' : p.title}</small>
                        </div>
                        <em>{roleLabel(p.role)}</em>
                      </div>
                    ))}
                  </div>
                  <MonthGrid />
                </aside>
              </section>
            )}
          </>
        )}

        {tab !== 'overview' && (
        <main className={`sheet${tab === 'agent' ? ' agent-sheet' : ''}`}>
          {orgSlug && tab === 'kpis' && (
            <>
              <div className="stage-head">
                <div>
                  <h1>KPIs</h1>
                  <p>{activeOrg?.short_name}. {membership.role === 'member' ? 'Measures assigned to you.' : 'Only this organisation.'}</p>
                  <p className="muted-line">
                    Green at goal · amber from 80% · red below.
                    {canManage && !canEditKpis ? ' Assign who owns each measure below.' : ''}
                    {!canManage ? ' View only.' : ''}
                    {canEditKpis ? ' Set daily goals on Overview, or edit the register below.' : ''}
                  </p>
                </div>
                {canEditKpis && <button className="primary" type="button" onClick={() => setKpiForm({ code: '', name: '', unit: 'count', how_often: 'Every day', target: '' })}>Add KPI</button>}
              </div>
              {canEditKpis && (
                <OwnerGoalSetter
                  title="Daily goals"
                  hint="Quick edit for every daily measure in this organisation."
                  kpis={dailyKpis}
                  emphasize
                  session={session}
                  api={api}
                  setError={setError}
                  onSaved={reloadOrgBits}
                />
              )}
              {canEditKpis && kpiForm && (
                <form className="inline" onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api(`/orgs/${orgSlug}/kpis`, session.token, { method: 'POST', body: JSON.stringify(kpiForm) });
                    setKpiForm(null);
                    await reloadOrgBits();
                  } catch (err) { setError(err.message); }
                }}>
                  <label>Name<input value={kpiForm.name} onChange={(e) => setKpiForm({ ...kpiForm, name: e.target.value })} required /></label>
                  <label>Code<input value={kpiForm.code} onChange={(e) => setKpiForm({ ...kpiForm, code: e.target.value })} placeholder={`${orgSlug}.new`} required /></label>
                  <label>Unit<input value={kpiForm.unit} onChange={(e) => setKpiForm({ ...kpiForm, unit: e.target.value })} /></label>
                  <label>How often
                    <select value={kpiForm.how_often} onChange={(e) => setKpiForm({ ...kpiForm, how_often: e.target.value })}>
                      {HOW_OFTEN_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </label>
                  <label>Goal<input type="number" step="any" value={kpiForm.target} onChange={(e) => setKpiForm({ ...kpiForm, target: e.target.value })} /></label>
                  <button className="primary" type="submit">Save</button>
                  <button className="quiet" type="button" onClick={() => setKpiForm(null)}>Cancel</button>
                </form>
              )}
              <table>
                <thead>
                  <tr>
                    <th>KPI</th>
                    <th>How often</th>
                    <th>Goal</th>
                    <th>Owned by</th>
                    {canEditKpis ? <th></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleKpis.map((k) => (
                    <tr key={k.id}>
                      <td>
                        {canEditKpis && editingKpi?.id === k.id ? (
                          <input value={editingKpi.name} onChange={(e) => setEditingKpi({ ...editingKpi, name: e.target.value })} />
                        ) : <><b>{k.name}</b><br /><span style={{ color: 'var(--muted)' }}>{k.code}</span></>}
                      </td>
                      <KpiCadenceCells k={k} canEdit={canEditKpis} session={session} api={api} setError={setError} onSaved={reloadOrgBits} />
                      <td>
                        {canManage ? (
                          <select
                            className="owner-select"
                            value={k.owner_id ?? ''}
                            onChange={async (e) => {
                              const owner_id = e.target.value || null;
                              try {
                                await api(`/kpis/${k.id}`, session.token, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ owner_id }),
                                });
                                await reloadOrgBits();
                              } catch (err) { setError(err.message); }
                            }}
                          >
                            <option value="">Unassigned</option>
                            {people.filter((p) => p.state !== 'inactive').map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.full_name} ({roleLabel(p.role)})
                              </option>
                            ))}
                          </select>
                        ) : (
                          k.owner_name || <span className="tag warn">Unassigned</span>
                        )}
                      </td>
                      {canEditKpis && (
                        <td className="actions">
                          {editingKpi?.id === k.id ? (
                            <>
                              <button className="linkish" type="button" onClick={async () => {
                                try {
                                  await api(`/kpis/${k.id}`, session.token, { method: 'PATCH', body: JSON.stringify({ name: editingKpi.name }) });
                                  setEditingKpi(null);
                                  await reloadOrgBits();
                                } catch (err) { setError(err.message); }
                              }}>Save</button>
                              <button className="linkish" type="button" onClick={() => setEditingKpi(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="linkish" type="button" onClick={() => setEditingKpi({ id: k.id, name: k.name })}>Edit</button>
                              <button className="linkish danger" type="button" onClick={async () => {
                                try {
                                  await api(`/kpis/${k.id}`, session.token, { method: 'DELETE' });
                                  await reloadOrgBits();
                                } catch (err) { setError(err.message); }
                              }}>Remove</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {orgSlug && tab === 'team' && (
            <>
              <div className="stage-head">
                <div>
                  <h1>Team</h1>
                  <p>{activeOrg?.short_name}. Members report to a team lead; team leads report to the manager.</p>
                </div>
                {canManage && (
                  <button
                    className="primary"
                    type="button"
                    onClick={() => setPersonForm({
                      full_name: '',
                      email: '',
                      title: 'Associate',
                      phone_e164: '',
                      role: 'member',
                      parent_id: people.find((p) => p.role === 'team_lead')?.id
                        || people.find((p) => p.role === 'manager')?.id
                        || '',
                    })}
                  >
                    Add person
                  </button>
                )}
              </div>
              {personForm && (
                <form className="inline" onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api(`/orgs/${orgSlug}/people`, session.token, {
                      method: 'POST',
                      body: JSON.stringify({
                        ...personForm,
                        parent_id: personForm.parent_id || null,
                      }),
                    });
                    setPersonForm(null);
                    await reloadOrgBits();
                  } catch (err) { setError(err.message); }
                }}>
                  <label>Name<input value={personForm.full_name} onChange={(e) => setPersonForm({ ...personForm, full_name: e.target.value })} required /></label>
                  <label>Email<input type="email" value={personForm.email} onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })} required /></label>
                  <label>Title<input value={personForm.title} onChange={(e) => setPersonForm({ ...personForm, title: e.target.value })} /></label>
                  <label>Role
                    <select value={personForm.role} onChange={(e) => setPersonForm({ ...personForm, role: e.target.value })}>
                      {assignableRoles.map((r) => (
                        <option key={r} value={r}>{roleLabel(r)}</option>
                      ))}
                    </select>
                  </label>
                  {personForm.role !== 'manager' && (
                    <label>Reports to
                      <select value={personForm.parent_id} onChange={(e) => setPersonForm({ ...personForm, parent_id: e.target.value })}>
                        <option value="">Default</option>
                        {people.filter((p) => ['manager', 'vice_manager', 'team_lead'].includes(p.role)).map((p) => (
                          <option key={p.id} value={p.id}>{p.full_name} ({roleLabel(p.role)})</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>WhatsApp<input value={personForm.phone_e164} onChange={(e) => setPersonForm({ ...personForm, phone_e164: e.target.value })} placeholder="+91..." /></label>
                  <button className="primary" type="submit">Save</button>
                  <button className="quiet" type="button" onClick={() => setPersonForm(null)}>Cancel</button>
                </form>
              )}
              <table>
                <thead><tr><th>Name</th><th>Title</th><th>WhatsApp</th><th>Role</th><th>Reports to</th><th></th></tr></thead>
                <tbody>
                  {people.map((p) => {
                    const reportsTo = people.find((x) => x.id === p.parent_id);
                    return (
                      <tr key={p.id}>
                        <td>
                          {editingPerson?.id === p.id
                            ? <input value={editingPerson.full_name} onChange={(e) => setEditingPerson({ ...editingPerson, full_name: e.target.value })} />
                            : p.full_name}
                        </td>
                        <td>
                          {editingPerson?.id === p.id
                            ? <input value={editingPerson.title} onChange={(e) => setEditingPerson({ ...editingPerson, title: e.target.value })} />
                            : p.title}
                        </td>
                        <td>
                          {editingPerson?.id === p.id
                            ? <input value={editingPerson.phone_e164 ?? ''} onChange={(e) => setEditingPerson({ ...editingPerson, phone_e164: e.target.value })} placeholder="+91..." />
                            : (p.phone_e164 || '—')}
                        </td>
                        <td>
                          {editingPerson?.id === p.id && (membership.role === 'owner' || p.role !== 'manager') ? (
                            <select
                              value={editingPerson.role}
                              onChange={(e) => setEditingPerson({ ...editingPerson, role: e.target.value })}
                            >
                              {assignableRoles.map((r) => (
                                <option key={r} value={r}>{roleLabel(r)}</option>
                              ))}
                            </select>
                          ) : roleLabel(p.role)}
                        </td>
                        <td>
                          {editingPerson?.id === p.id && editingPerson.role !== 'manager' ? (
                            <select
                              value={editingPerson.parent_id ?? ''}
                              onChange={(e) => setEditingPerson({ ...editingPerson, parent_id: e.target.value })}
                            >
                              <option value="">—</option>
                              {people.filter((x) => x.id !== p.id && ['manager', 'vice_manager', 'team_lead'].includes(x.role)).map((x) => (
                                <option key={x.id} value={x.id}>{x.full_name}</option>
                              ))}
                            </select>
                          ) : (reportsTo?.full_name || '—')}
                        </td>
                        <td className="actions">
                          {p.state === 'pending_name' && editingPerson?.id !== p.id && <span className="tag warn">Name pending</span>}
                          {canManage && editingPerson?.id === p.id && (
                            <>
                              <button className="linkish" type="button" onClick={async () => {
                                try {
                                  await api(`/people/${p.id}`, session.token, {
                                    method: 'PATCH',
                                    body: JSON.stringify({
                                      ...editingPerson,
                                      parent_id: editingPerson.parent_id || null,
                                    }),
                                  });
                                  setEditingPerson(null);
                                  await reloadOrgBits();
                                } catch (err) { setError(err.message); }
                              }}>Save</button>
                              <button className="linkish" type="button" onClick={() => setEditingPerson(null)}>Cancel</button>
                            </>
                          )}
                          {canManage && editingPerson?.id !== p.id && p.id !== membership.id && (membership.role === 'owner' || p.role !== 'manager') && (
                            <>
                              <button
                                className="linkish"
                                type="button"
                                onClick={() => setEditingPerson({
                                  id: p.id,
                                  full_name: p.full_name,
                                  title: p.title,
                                  phone_e164: p.phone_e164 ?? '',
                                  role: p.role,
                                  parent_id: p.parent_id ?? '',
                                })}
                              >
                                Edit
                              </button>
                              <button className="linkish danger" type="button" onClick={async () => {
                                try {
                                  await api(`/people/${p.id}`, session.token, { method: 'DELETE' });
                                  await reloadOrgBits();
                                } catch (err) { setError(err.message); }
                              }}>Remove</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {orgSlug && tab === 'today' && (
            <TodayBoard
              activeOrg={activeOrg}
              membership={membership}
              visibleKpis={visibleKpis}
              dailyKpis={dailyKpis}
              weeklyKpis={weeklyKpis}
              monthlyKpis={monthlyKpis}
              pendingTodayKpis={pendingTodayKpis}
              pendingMonthlyKpis={pendingMonthlyKpis}
              submittedCodes={submittedCodes}
              submissions={submissions}
              waitingReview={waitingReview}
              todayDone={todayDone}
              todayTotal={todayTotal}
              todayPct={todayPct}
              editingSub={editingSub}
              setEditingSub={setEditingSub}
              submitKpiValue={submitKpiValue}
              validate={validate}
              signoff={signoff}
              refreshToday={refreshToday}
              reloadOrgBits={reloadOrgBits}
              orgSlug={orgSlug}
              session={session}
              api={api}
              setError={setError}
              canReview={canReview}
              canLock={canLock}
              canManage={canManage}
              canEditKpis={canEditKpis}
              quarterlyKpis={quarterlyKpis}
            />
          )}

          {tab === 'account' && (
            <AccountPanel
              session={session}
              setSession={setSession}
              activeOrg={activeOrg}
              orgs={orgs}
              api={api}
              setError={setError}
              setMyPhone={setMyPhone}
            />
          )}

          {tab === 'settings' && membership.role === 'owner' && (
            <WhatsAppSettingsPanel session={session} api={api} setError={setError} />
          )}

          {tab === 'agent' && membership.role === 'owner' && (
            <AgentChatPanel
              orgSlug={orgSlug}
              activeOrg={activeOrg}
              chat={chat}
              chatBusy={chatBusy}
              chatText={chatText}
              setChatText={setChatText}
              chatHistoryOpen={chatHistoryOpen}
              setChatHistoryOpen={setChatHistoryOpen}
              chatSessions={chatSessions}
              chatSessionId={chatSessionId}
              thinkPhase={thinkPhase}
              myPhone={myPhone}
              setMyPhone={setMyPhone}
              session={session}
              setSession={setSession}
              setChat={setChat}
              setChatSessionId={setChatSessionId}
              setChatBusy={setChatBusy}
              setError={setError}
              api={api}
              loadChatSession={loadChatSession}
              refreshChatHistory={refreshChatHistory}
              chatScrollRef={chatScrollRef}
              chatEndRef={chatEndRef}
            />
          )}
        </main>
        )}
      </div>
    </div>
  );
}

const THINK_LABELS = ['', 'Reading your question', 'Calling portfolio tools', 'Writing the answer'];

/* ---- Agent reply rendering ------------------------------------------------------------
   The playbook asks the agent for plain lines with [tags]; the runner keeps the tags for the
   dashboard and swaps them for words on WhatsApp:
     headline · "[bad] PATS · Drone serviceability — 66.7% of 90%, day" · "[locked] TMS — locked · 2 bad" · "Next: …"
   Tags become SVG icons here. Older chats saved with emoji are mapped to the same tags. */
const ICON_PATHS = {
  bad: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></>,
  watch: <><path d="M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 17h.01" /></>,
  good: <><circle cx="12" cy="12" r="9" /><path d="m8.3 12.2 2.5 2.5 5-5.2" /></>,
  unscored: <circle cx="12" cy="12" r="9" strokeDasharray="3.2 3.2" />,
  locked: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" /></>,
  open: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></>,
  person: <><circle cx="12" cy="8" r="3.8" /><path d="M4.8 20.5a7.2 7.2 0 0 1 14.4 0" /></>,
  saved: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  next: <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />,
  warn: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  '-': <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />,
};

function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name] ?? ICON_PATHS['-']}
    </svg>
  );
}

const RAG_TAGS = {
  good: { tone: 'good', label: 'Good' },
  watch: { tone: 'watch', label: 'Watch' },
  bad: { tone: 'bad', label: 'Bad' },
  unscored: { tone: 'none', label: 'Not scored' },
};
const ITEM_TAGS = ['locked', 'open', 'person', 'saved', '-'];
const LEGACY_EMOJI = [
  [/🔴/gu, '[bad]'], [/🟡|🟠/gu, '[watch]'], [/🟢/gu, '[good]'], [/⚪/gu, '[unscored]'],
  [/🔒/gu, '[locked]'], [/⏳|⌛/gu, '[open]'], [/👤/gu, '[person]'], [/✅/gu, '[saved]'],
];

function normaliseReply(text) {
  let out = String(text ?? '')
    .replace(/```[a-z]*\n?|```/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '[-] ')
    .replace(/\*\*/g, '');
  for (const [re, tag] of LEGACY_EMOJI) out = out.replace(re, tag);
  return out.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '');
}

function parseReply(text) {
  const lines = normaliseReply(text).split('\n').map((l) => l.trim());
  const blocks = [];
  let headlineTaken = false;
  for (const raw of lines) {
    if (!raw) continue;
    const tagMatch = /^\[([a-z-]+)\]\s*/i.exec(raw);
    const tag = tagMatch?.[1].toLowerCase();
    const line = tagMatch ? raw.slice(tagMatch[0].length) : raw;
    if (tag && RAG_TAGS[tag]) {
      const [left, right = ''] = line.split(/\s+[—–-]\s+/, 2);
      const [org, name] = left.includes(' · ') ? left.split(' · ', 2) : ['', left];
      const cut = right.lastIndexOf(', ');
      const value = cut > 0 ? right.slice(0, cut) : right;
      const cadence = cut > 0 ? right.slice(cut + 2) : '';
      blocks.push({ kind: 'kpi', tag, ...RAG_TAGS[tag], org, name, value, cadence });
    } else if (tag && ITEM_TAGS.includes(tag)) {
      const status = /^(.+?)\s+[—–-]\s+(locked|not locked)\b\s*(?:·\s*(.*))?$/i.exec(line);
      if ((tag === 'locked' || tag === 'open') && status) {
        const counts = {};
        for (const m of (status[3] ?? '').matchAll(/(\d+)\s+(bad|watch|good)/gi)) counts[m[2].toLowerCase()] = Number(m[1]);
        blocks.push({ kind: 'status', org: status[1], locked: /^locked$/i.test(status[2]), counts });
      } else {
        blocks.push({ kind: 'item', tag, text: line });
      }
    } else if (/^next:/i.test(line)) {
      blocks.push({ kind: 'next', text: line.replace(/^next:\s*/i, '') });
    } else if (/^\+\d+ more/i.test(line)) {
      blocks.push({ kind: 'more', text: line });
    } else if (/^not saved\b/i.test(line)) {
      blocks.push({ kind: 'warn', text: line });
    } else if (!headlineTaken && blocks.length === 0 && line.length <= 70 && !/[?!]$/.test(line)) {
      blocks.push({ kind: 'headline', text: line.replace(/[:.]$/, '') });
    } else if (/:$/.test(line) && line.length <= 50) {
      blocks.push({ kind: 'section', text: line.slice(0, -1) });
    } else {
      blocks.push({ kind: 'text', text: line });
    }
    headlineTaken = true;
  }
  return blocks;
}

function Tally({ tone, n }) {
  return (
    <span className={`tally tally-${tone}`}>
      <Icon name={tone} size={12} />
      {n} {tone}
    </span>
  );
}

function AgentReply({ text }) {
  const blocks = parseReply(text);
  const kpis = blocks.filter((b) => b.kind === 'kpi');
  const counts = ['bad', 'watch', 'good'].map((tone) => [tone, kpis.filter((k) => k.tone === tone).length]);
  return (
    <div className="reply">
      {blocks.map((b, i) => {
        if (b.kind === 'headline') {
          return (
            <div key={i} className="reply-head">
              <span>{b.text}</span>
              {kpis.length >= 2 && (
                <span className="reply-tally">
                  {counts.filter(([, n]) => n > 0).map(([tone, n]) => <Tally key={tone} tone={tone} n={n} />)}
                </span>
              )}
            </div>
          );
        }
        if (b.kind === 'kpi') {
          return (
            <div key={i} className={`reply-kpi tone-${b.tone}`}>
              <span className="reply-kpi-icon"><Icon name={b.tag} size={18} /></span>
              <span className="reply-kpi-main">
                <span className="reply-kpi-name">{b.name}</span>
                <span className="reply-kpi-sub">{[b.label, b.org, b.cadence].filter(Boolean).join(' · ')}</span>
              </span>
              {b.value && <span className="reply-kpi-value">{b.value}</span>}
            </div>
          );
        }
        if (b.kind === 'status') {
          const shown = ['bad', 'watch', 'good'].filter((t) => b.counts[t] > 0);
          return (
            <div key={i} className={`reply-status${b.locked ? '' : ' is-open'}`}>
              <span className="reply-status-org">
                <Icon name={b.locked ? 'locked' : 'open'} size={15} className="reply-status-icon" />
                {b.org}
              </span>
              <span className="reply-status-counts">
                {shown.map((t) => <Tally key={t} tone={t} n={b.counts[t]} />)}
                {!b.locked && <span className="reply-status-lock">Not locked</span>}
              </span>
            </div>
          );
        }
        if (b.kind === 'item') {
          return (
            <div key={i} className={`reply-item${b.tag === 'saved' ? ' is-done' : ''}`}>
              <Icon name={b.tag} size={15} className="reply-item-icon" />
              <span>{b.text}</span>
            </div>
          );
        }
        if (b.kind === 'section') return <div key={i} className="reply-section">{b.text}</div>;
        if (b.kind === 'next') {
          return (
            <div key={i} className="reply-next">
              <Icon name="next" size={14} className="reply-next-icon" />
              <span>{b.text}</span>
            </div>
          );
        }
        if (b.kind === 'more') return <div key={i} className="reply-more">{b.text}</div>;
        if (b.kind === 'warn') {
          return (
            <div key={i} className="reply-warn">
              <Icon name="warn" size={15} />
              <span>{b.text}</span>
            </div>
          );
        }
        return <p key={i} className="reply-text">{b.text}</p>;
      })}
    </div>
  );
}

function AgentChatPanel({
  orgSlug,
  activeOrg,
  chat,
  chatBusy,
  chatText,
  setChatText,
  chatHistoryOpen,
  setChatHistoryOpen,
  chatSessions,
  chatSessionId,
  thinkPhase,
  myPhone,
  setMyPhone,
  session,
  setSession,
  setChat,
  setChatSessionId,
  setChatBusy,
  setError,
  api,
  loadChatSession,
  refreshChatHistory,
  chatScrollRef,
  chatEndRef,
}) {
  async function sendMessage(e) {
    e.preventDefault();
    const text = chatText.trim();
    if (!text || chatBusy) return;
    setChatBusy(true);
    setChatText('');
    setChat((current) => [...current, { role: 'user', content: text }]);
    try {
      const data = await api('/agent/chat', session.token, {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          session_id: chatSessionId,
          focus_org_slug: orgSlug || '',
        }),
      });
      setChatSessionId(data.session_id ?? chatSessionId);
      setChat(data.messages ?? []);
      refreshChatHistory(session.token).catch(() => {});
    } catch (err) {
      setError(err.message);
      setChat((current) => current.slice(0, -1));
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="agent-layout">
      <header className="agent-top">
        <div className="agent-top-copy">
          <h1>Agent</h1>
          <p>Portfolio questions and targets. The same reply goes out on WhatsApp.</p>
          {orgSlug && (
            <p className="agent-org-focus">
              Org in focus: <strong>{activeOrg?.short_name ?? orgSlug}</strong>
              <span className="agent-org-hint"> — list KPIs and readiness default here unless you name another org.</span>
            </p>
          )}
        </div>
        <div className="agent-actions">
          <button
            className="quiet"
            type="button"
            disabled={chatBusy}
            onClick={async () => {
              try {
                const data = await api('/agent/chat/sessions', session.token, { method: 'POST', body: '{}' });
                setChatSessionId(data.session_id);
                setChat([]);
                setChatHistoryOpen(false);
                await refreshChatHistory(session.token);
              } catch (err) { setError(err.message); }
            }}
          >
            New chat
          </button>
          <button
            className={`quiet${chatHistoryOpen ? ' active' : ''}`}
            type="button"
            onClick={async () => {
              const next = !chatHistoryOpen;
              setChatHistoryOpen(next);
              if (next) {
                try {
                  await refreshChatHistory(session.token);
                } catch (err) { setError(err.message); }
              }
            }}
          >
            History
          </button>
        </div>
      </header>

      {chatHistoryOpen && (
        <div className="chat-history agent-history">
          {chatSessions.length === 0 && <p className="muted-line">No past chats yet.</p>}
          {chatSessions.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`history-item${item.id === chatSessionId ? ' current' : ''}`}
              onClick={async () => {
                try {
                  await loadChatSession(item.id, session.token);
                  setChatHistoryOpen(false);
                } catch (err) { setError(err.message); }
              }}
            >
              <span className="history-title">{item.title || 'New chat'}</span>
              <span className="history-meta">
                {item.message_count > 0 ? `${item.message_count} messages` : 'Empty'}
                {' · '}
                {new Date(item.last_seen_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </button>
          ))}
        </div>
      )}

      <form
        className="agent-phone"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const data = await api('/me', session.token, { method: 'PATCH', body: JSON.stringify({ phone_e164: myPhone }) });
            setSession({ ...session, membership: data.membership });
          } catch (err) { setError(err.message); }
        }}
      >
        <label>
          WhatsApp for replies
          <input value={myPhone} onChange={(e) => setMyPhone(e.target.value)} placeholder="+91..." />
        </label>
        <button className="quiet" type="submit">Save</button>
      </form>

      <div className="agent-messages" ref={chatScrollRef}>
        {chat.length === 0 && !chatBusy && (
          <div className="agent-empty">
            <p>Ask how ready SAI is, who owns a KPI, or to set a target.</p>
          </div>
        )}
        {chat.map((item, i) => (
          <article
            key={`${chatSessionId ?? 'chat'}-${i}-${item.role}`}
            className={`agent-msg agent-msg-${item.role}${item.role === 'assistant' && item.tools?.length ? ' has-tools' : ''}`}
          >
            <div className="agent-msg-meta">{item.role === 'user' ? 'You' : 'Portfolio'}</div>
            <div className="agent-bubble">
              {item.role === 'assistant' ? <AgentReply text={item.content} /> : <p>{item.content}</p>}
              {item.role === 'assistant' && item.tools?.length > 0 && (
                <ul className="tool-calls" aria-label="Tools used">
                  {[...item.tools.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map())].map(([tool, n], ti) => (
                    <li key={tool} className="tool-call done" style={{ animationDelay: `${ti * 80}ms` }}>
                      <span className="tool-call-icon"><Icon name="saved" size={12} /></span>
                      <span>{TOOL_LABELS[tool] ?? tool}{n > 1 ? ` ×${n}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        ))}
        {chatBusy && (
          <article className="agent-msg agent-msg-assistant thinking" aria-live="polite" aria-busy="true">
            <div className="agent-msg-meta">Portfolio</div>
            <div className="agent-bubble thinking-bubble">
              <div className="think-row">
                <span className="think-dots" aria-hidden>
                  <i /><i /><i />
                </span>
                <span className="think-label">{THINK_LABELS[thinkPhase] || 'Thinking'}</span>
              </div>
              {thinkPhase >= 2 && (
                <ul className="tool-calls pending">
                  <li className="tool-call pulse">
                    <span className="tool-call-spinner" aria-hidden />
                    <span>Portfolio tool</span>
                  </li>
                </ul>
              )}
            </div>
          </article>
        )}
        <div ref={chatEndRef} className="agent-scroll-anchor" />
      </div>

      <form className="agent-composer" onSubmit={sendMessage}>
        <textarea
          rows={1}
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage(e);
            }
          }}
          placeholder="Ask the portfolio…"
          disabled={chatBusy}
          aria-label="Message"
        />
        <button className="primary agent-send" type="submit" disabled={chatBusy || !chatText.trim()}>
          {chatBusy ? (
            <span className="send-busy"><span className="think-dots compact"><i /><i /><i /></span></span>
          ) : (
            'Send'
          )}
        </button>
      </form>
    </div>
  );
}

function whatsappStateLabel(info) {
  if (!info) return '…';
  if (!info.configured) return 'Not set up';
  if (info.sidecar_error) return 'Sidecar offline';
  if (info.connected) return 'Connected';
  if (info.has_qr) return 'Scan QR';
  if (info.state === 'qr_pending') return 'Scan QR';
  if (info.state === 'reconnecting') return 'Reconnecting';
  if (info.state === 'degraded') return 'Needs attention';
  if (info.ready === false) return 'Waiting on sidecar';
  return 'Click Generate QR';
}

function TodayBoard({
  activeOrg,
  membership,
  visibleKpis,
  dailyKpis,
  weeklyKpis,
  monthlyKpis,
  pendingTodayKpis,
  pendingMonthlyKpis,
  submittedCodes,
  submissions,
  waitingReview,
  todayDone,
  todayTotal,
  todayPct,
  editingSub,
  setEditingSub,
  submitKpiValue,
  validate,
  signoff,
  refreshToday,
  reloadOrgBits,
  orgSlug,
  session,
  api,
  setError,
  canReview,
  canLock,
  canManage,
  canEditKpis,
  quarterlyKpis,
}) {
  const allDone = todayTotal > 0 && todayDone >= todayTotal;
  const unsetCount = visibleKpis.filter((k) => k.target == null).length;

  // Owner: one job only — type goals and save. No "today numbers" clutter.
  if (canEditKpis) {
    const cadenceBlocks = [];
    if (dailyKpis.length) cadenceBlocks.push({ title: 'Daily', kpis: dailyKpis });
    if (weeklyKpis.length) cadenceBlocks.push({ title: 'Weekly', kpis: weeklyKpis });
    if (monthlyKpis.length) cadenceBlocks.push({ title: 'Monthly', kpis: monthlyKpis });
    if (quarterlyKpis.length) cadenceBlocks.push({ title: 'Quarterly', kpis: quarterlyKpis });

    const cadenceSummary = [
      dailyKpis.length ? `${dailyKpis.length} daily` : null,
      weeklyKpis.length ? `${weeklyKpis.length} weekly` : null,
      monthlyKpis.length ? `${monthlyKpis.length} monthly` : null,
      quarterlyKpis.length ? `${quarterlyKpis.length} quarterly` : null,
    ].filter(Boolean).join(' · ');

    return (
      <div className="today owner-today">
        <div className="stage-head">
          <div>
            <h1>Set goals</h1>
            <p>{activeOrg?.short_name} · goals apply to the KPI register for this org</p>
          </div>
          <div className="today-progress-meta">
            <strong>{visibleKpis.length - unsetCount}/{visibleKpis.length || '—'}</strong>
            <span>goals set</span>
          </div>
        </div>

        <div className={`owner-howto${unsetCount ? ' needs-work' : ''}`}>
          <p className="owner-register-note">
            <b>{visibleKpis.length}</b> measures on the register
            {cadenceSummary ? <> ({cadenceSummary})</> : null}.
            {' '}Monthly shows only KPIs marked <em>Every month</em> in the register — not “everything you do each month.”
          </p>
          <ol>
            <li>Type a <b>goal</b> in each box (what “good” looks like).</li>
            <li>Click <b>Save goals</b> on each block.</li>
            <li>Need something new? Use <b>Add measure</b> below (still goes on the register).</li>
          </ol>
          {unsetCount > 0 && (
            <p className="owner-howto-warn">{unsetCount} measures still have no goal.</p>
          )}
        </div>

        <OwnerAddMeasure
          orgSlug={orgSlug}
          session={session}
          api={api}
          setError={setError}
          onAdded={reloadOrgBits}
        />

        <div className="owner-cadence-stack">
          {cadenceBlocks.map((block, i) => (
            <OwnerGoalSetter
              key={block.title}
              title={`${i + 1}. ${block.title} goals`}
              hint={`${block.kpis.length} measure${block.kpis.length === 1 ? '' : 's'} · cadence: Every ${block.title.toLowerCase()}`}
              kpis={block.kpis}
              emphasize={i === 0}
              session={session}
              api={api}
              setError={setError}
              onSaved={reloadOrgBits}
            />
          ))}
          {cadenceBlocks.length === 0 && (
            <div className="today-empty">No measures yet. Add one above, or use the KPIs tab.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="today">
      <div className="stage-head">
        <div>
          <h1>Today</h1>
          <p>{activeOrg?.short_name} · {prettyDate()}</p>
        </div>
        <div className="today-progress-meta">
          <strong>{todayDone}/{todayTotal || '—'}</strong>
          <span>daily sent</span>
        </div>
      </div>

      <div className="today-progress" aria-label={`${todayPct}% of today's measures sent`}>
        <div className="today-meter">
          <i style={{ width: `${todayPct}%` }} />
        </div>
        <p className="muted-line">
          {todayTotal === 0
            ? 'No daily measures on the register yet.'
            : allDone
              ? 'All daily measures are in.'
              : `${pendingTodayKpis.length} daily still open · send numbers against the goal.`}
        </p>
      </div>

      {canManage && (
        <section className="today-section">
          <div className="today-section-head">
            <h2>Goals from Thyagu</h2>
            <span>{visibleKpis.length}</span>
          </div>
          {visibleKpis.length === 0 ? (
            <div className="today-empty">No KPIs in this organisation yet.</div>
          ) : (
            <ul className="goal-list">
              {visibleKpis.map((k) => (
                <li key={k.id} className="goal-row">
                  <div>
                    <b>{k.name}</b>
                    <span>{k.code} · {trackedLabel(k)}{k.owner_name ? ` · ${k.owner_name}` : ''}</span>
                  </div>
                  <div className="goal-target">
                    {k.target == null
                      ? <span className="tag warn">No goal</span>
                      : <><strong>{k.target}</strong> <em>{k.unit}</em></>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="today-section">
        <div className="today-section-head">
          <h2>Today&apos;s numbers</h2>
          <span>{pendingTodayKpis.length} open</span>
        </div>
        {dailyKpis.length === 0 ? (
          <div className="today-empty">No daily KPIs for you to send today.</div>
        ) : pendingTodayKpis.length === 0 ? (
          <div className="today-empty">All daily numbers are in.</div>
        ) : (
          <ul className="today-list">
            {pendingTodayKpis.map((k) => (
              <PendingKpiRow key={k.id} kpi={k} onSubmit={submitKpiValue} />
            ))}
          </ul>
        )}
      </section>

      {(canManage || monthlyKpis.length > 0) && (
        <section className="today-section">
          <div className="today-section-head">
            <h2>Monthly numbers</h2>
            <span>{pendingMonthlyKpis.length} open</span>
          </div>
          {monthlyKpis.length === 0 ? (
            <div className="today-empty">No monthly KPIs.</div>
          ) : pendingMonthlyKpis.length === 0 ? (
            <div className="today-empty">All monthly numbers are in for today&apos;s period.</div>
          ) : (
            <ul className="today-list">
              {pendingMonthlyKpis.map((k) => (
                <PendingKpiRow key={k.id} kpi={k} onSubmit={submitKpiValue} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="today-section">
        <div className="today-section-head">
          <h2>Sent today</h2>
          <span>{submissions.length}</span>
        </div>
        {submissions.length === 0 ? (
          <div className="today-empty">Nothing submitted yet. Use the rows above.</div>
        ) : (
          <ul className="today-list">
            {submissions.map((s) => {
              const label = submissionLabel(s.state);
              return (
                <li key={s.id} className="today-row is-sent">
                  <div className="today-row-main">
                    <div className="today-row-title">
                      <b>{s.kpi_name || s.kpi_code}</b>
                      <span>{s.kpi_code}</span>
                    </div>
                    <div className="today-row-value">
                      {editingSub?.id === s.id ? (
                        <input
                          className="today-input"
                          type="number"
                          step="any"
                          value={editingSub.value}
                          onChange={(e) => setEditingSub({ ...editingSub, value: e.target.value })}
                          autoFocus
                        />
                      ) : (
                        <strong>{s.value}{s.kpi_unit ? ` ${s.kpi_unit}` : ''}</strong>
                      )}
                      {s.kpi_goal != null && editingSub?.id !== s.id && (
                        <em>Goal {s.kpi_goal}</em>
                      )}
                    </div>
                    <span className={`tag ${label.tone}`}>{label.text}</span>
                  </div>
                  <div className="today-row-actions">
                    {canReview && s.state === 'submitted' && (
                      <>
                        <button className="quiet" type="button" onClick={() => validate(s.id, true)}>Accept</button>
                        <button className="quiet" type="button" onClick={() => validate(s.id, false)}>Reject</button>
                      </>
                    )}
                    {s.state !== 'locked' && editingSub?.id === s.id && (
                      <>
                        <button
                          className="linkish"
                          type="button"
                          onClick={async () => {
                            try {
                              await api(`/submissions/${s.id}`, session.token, {
                                method: 'PATCH',
                                body: JSON.stringify({ value: Number(editingSub.value) }),
                              });
                              setEditingSub(null);
                              await refreshToday();
                            } catch (err) { setError(err.message); }
                          }}
                        >
                          Save
                        </button>
                        <button className="linkish" type="button" onClick={() => setEditingSub(null)}>Cancel</button>
                      </>
                    )}
                    {s.state !== 'locked' && editingSub?.id !== s.id && (
                      <>
                        <button className="linkish" type="button" onClick={() => setEditingSub({ id: s.id, value: s.value })}>Edit</button>
                        <button
                          className="linkish danger"
                          type="button"
                          onClick={async () => {
                            try {
                              await api(`/submissions/${s.id}`, session.token, { method: 'DELETE' });
                              await refreshToday();
                            } catch (err) { setError(err.message); }
                          }}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canLock && (
        <div className="today-lock">
          <div>
            <h2>Lock the day</h2>
            <p className="muted-line">
              {waitingReview.length
                ? `${waitingReview.length} still waiting for accept/reject.`
                : allDone
                  ? 'Ready to lock accepted numbers for today.'
                  : 'You can lock once accepted numbers are in.'}
            </p>
          </div>
          <button className="primary" type="button" onClick={signoff}>
            Lock the day
          </button>
        </div>
      )}
    </div>
  );
}

function PendingKpiRow({ kpi, onSubmit }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e) {
    e.preventDefault();
    if (value === '' || busy) return;
    setBusy(true);
    try {
      await onSubmit(kpi.code, value);
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="today-row is-pending">
      <form className="today-row-main today-send-form" onSubmit={send}>
        <div className="today-row-title">
          <b>{kpi.name}</b>
          <span>{kpi.code}</span>
        </div>
        <div className="today-row-goal">
          {kpi.target == null ? (
            <span className="tag warn">No goal</span>
          ) : (
            <span>Goal <strong>{kpi.target}</strong> {kpi.unit}</span>
          )}
          <span className="today-cadence">{kpi.how_often}</span>
        </div>
        <label className="today-field">
          <span>Value</span>
          <input
            className="today-input"
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kpi.unit || 'Number'}
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy || value === ''}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </li>
  );
}

function OwnerAddMeasure({ orgSlug, session, api, setError, onAdded }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: '',
    how_often: 'Every week',
    unit: 'count',
    target: '',
  });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const code = slugifyMeasureCode(orgSlug, form.name);
      const body = {
        code,
        name: form.name.trim(),
        unit: form.unit || 'count',
        how_often: form.how_often,
        target: form.target === '' ? null : Number(form.target),
      };
      await api(`/orgs/${orgSlug}/kpis`, session.token, { method: 'POST', body: JSON.stringify(body) });
      setForm({ name: '', how_often: 'Every week', unit: 'count', target: '' });
      setOpen(false);
      await onAdded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="owner-add-measure">
      {!open ? (
        <button className="soft" type="button" onClick={() => setOpen(true)}>
          + Add measure to register
        </button>
      ) : (
        <form className="owner-add-form" onSubmit={submit}>
          <div className="today-section-head">
            <h2>Add measure</h2>
            <button className="quiet" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <p className="muted-line">Creates a new line on the KPI register for this org (same as KPIs → Add KPI).</p>
          <div className="owner-add-fields">
            <label>
              Name
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Newsletter opens"
                required
              />
            </label>
            <label>
              How often
              <select value={form.how_often} onChange={(e) => setForm({ ...form, how_often: e.target.value })}>
                {HOW_OFTEN_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label>
              Unit
              <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </label>
            <label>
              Goal (optional)
              <input type="number" step="any" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
            </label>
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add to register'}
          </button>
        </form>
      )}
    </div>
  );
}

function OwnerGoalSetter({
  title,
  hint,
  kpis,
  emphasize = false,
  session,
  api,
  setError,
  onSaved,
}) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const next = {};
    for (const k of kpis) next[k.id] = k.target == null ? '' : String(k.target);
    setDrafts(next);
    setSaved(false);
  }, [kpis]);

  const missing = kpis.filter((k) => k.target == null).length;

  async function saveAll(e) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const jobs = [];
      for (const k of kpis) {
        const raw = drafts[k.id];
        if (raw === '' || raw == null) continue;
        const target = Number(raw);
        if (!Number.isFinite(target)) {
          throw new Error(`“${k.name}” needs a valid number.`);
        }
        if (k.target != null && Number(k.target) === target) continue;
        jobs.push(
          api('/kpis/target', session.token, {
            method: 'POST',
            body: JSON.stringify({ kpi_code: k.code, target }),
          }),
        );
      }
      await Promise.all(jobs);
      setSaved(true);
      await onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={`owner-goal-card${emphasize ? ' is-primary' : ''}`}
      onSubmit={saveAll}
    >
      <div className="today-section-head">
        <h2>{title}</h2>
        <span>{missing ? `${missing} unset` : `${kpis.length} set`}</span>
      </div>
      {hint && <p className="muted-line">{hint}</p>}
      {kpis.length === 0 ? (
        <div className="today-empty">No measures in this cadence.</div>
      ) : (
        <ul className="owner-goal-list">
          {kpis.map((k) => (
            <li key={k.id} className={`owner-goal-row${k.target == null ? ' is-missing' : ''}`}>
              <div className="owner-goal-copy">
                <b>{k.name}</b>
                <span>{k.how_often}{k.owner_name ? ` · ${k.owner_name}` : ''}</span>
              </div>
              <label className="owner-goal-field">
                <span>Goal</span>
                <div className="owner-goal-input-wrap">
                  <input
                    type="number"
                    step="any"
                    value={drafts[k.id] ?? ''}
                    placeholder="—"
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [k.id]: e.target.value }))}
                  />
                  <em>{k.unit || ''}</em>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
      {kpis.length > 0 && (
        <div className="owner-goal-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save goals'}
          </button>
          {saved && <span className="tag ok">Saved</span>}
        </div>
      )}
    </form>
  );
}

function AccountPanel({ session, setSession, activeOrg, orgs, api, setError, setMyPhone }) {
  const m = session?.membership;
  const [fullName, setFullName] = useState(m?.full_name ?? '');
  const [phone, setPhone] = useState(m?.phone_e164 ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api('/me', session.token);
        if (cancelled || !data.membership) return;
        setSession((prev) => ({ ...prev, membership: data.membership }));
        setFullName(data.membership.full_name ?? '');
        setPhone(data.membership.phone_e164 ?? '');
        setMyPhone?.(data.membership.phone_e164 ?? '');
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [session.token]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const data = await api('/me', session.token, {
        method: 'PATCH',
        body: JSON.stringify({
          full_name: fullName.trim(),
          phone_e164: phone.trim() || null,
        }),
      });
      setSession((prev) => ({ ...prev, membership: data.membership }));
      setMyPhone?.(data.membership.phone_e164 ?? '');
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const orgLabel = m?.org_short_name
    || activeOrg?.short_name
    || (m?.role === 'owner' ? 'All organisations' : '—');
  const reportsTo = m?.reports_to_name
    ? `${m.reports_to_name}${m.reports_to_role ? ` (${roleLabel(m.reports_to_role)})` : ''}`
    : m?.role === 'owner'
      ? '—'
      : '—';

  return (
    <div className="account-page">
      <div className="stage-head">
        <div>
          <h1>Account</h1>
          <p>Your profile on PortfolioOS.</p>
        </div>
      </div>

      <div className="account-grid">
        <section className="account-card">
          <h2>Profile</h2>
          <form className="account-form" onSubmit={save}>
            <label>
              Full name
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </label>
            <label>
              Email
              <input value={m?.email ?? ''} readOnly disabled />
            </label>
            <label>
              WhatsApp
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91..."
              />
            </label>
            <div className="account-actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              {saved && <span className="tag ok">Saved</span>}
            </div>
          </form>
        </section>

        <section className="account-card">
          <h2>Role &amp; organisation</h2>
          <dl className="account-meta">
            <div><dt>Role</dt><dd>{roleLabel(m?.role)}</dd></div>
            <div><dt>Title</dt><dd>{m?.title || '—'}</dd></div>
            <div><dt>Organisation</dt><dd>{orgLabel}</dd></div>
            <div><dt>Reports to</dt><dd>{reportsTo}</dd></div>
            <div><dt>Status</dt><dd>{m?.state === 'pending_name' ? 'Name pending' : (m?.state || 'active')}</dd></div>
            {m?.role === 'owner' && (
              <div><dt>Portfolio</dt><dd>{orgs.length} organisations</dd></div>
            )}
          </dl>
        </section>
      </div>
    </div>
  );
}

function WhatsAppSettingsPanel({ session, api, setError }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const data = await api('/settings/whatsapp', session.token);
      setInfo(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    refresh();
  }, [session.token]);

  useEffect(() => {
    if (!info || info.connected || !info.configured) return undefined;
    const id = setInterval(() => {
      refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [info?.connected, info?.configured, session.token]);

  async function startLink() {
    setBusy(true);
    try {
      const data = await api('/settings/whatsapp/start', session.token, { method: 'POST' });
      setInfo(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
  <>
    <div className="stage-head">
      <div>
        <h1>Settings</h1>
        <p>Link WhatsApp so registered numbers can talk to the portfolio agent.</p>
      </div>
      <button className="quiet" type="button" onClick={refresh} disabled={busy}>Refresh</button>
    </div>

    <section className="wa-settings">
      <div className="wa-card">
        <div className="wa-card-head">
          <h2>WhatsApp</h2>
          {info && (
            <span className={`tag ${info.connected ? 'ok' : info.configured && !info.sidecar_error ? 'warn' : 'warn'}`}>
              {whatsappStateLabel(info)}
            </span>
          )}
        </div>

        {!info && <p className="muted">Loading…</p>}

        {info && !info.configured && (
          <div className="wa-hint">
            <p>{info.message}</p>
            <ul>
              <li>Run <code>platform/qlix-whatsapp-service</code> on port <strong>3939</strong> with <code>QLIX_URL=http://127.0.0.1:3938</code>.</li>
              <li>Set <code>WA_SERVICE_URL</code>, <code>WA_CONNECTOR_ID</code> (UUID), and <code>WA_SERVICE_SECRET</code> in <code>.env</code>.</li>
              <li>Run <code>wa-gateway</code> on <strong>3938</strong>.</li>
              <li>Restart the API with <code>npm run api:dev</code> from <code>sona-ecosystem</code> (it must load <code>.env</code>).</li>
            </ul>
          </div>
        )}

        {info?.configured && (
          <>
            <p className="muted wa-lead">{info.message}</p>
            {info.qr_image && !info.connected && (
              <div className="wa-qr-wrap">
                <img src={info.qr_image} alt="WhatsApp QR code" className="wa-qr" width={280} height={280} />
                <p className="muted">QR refreshes every few seconds — keep this page open while scanning.</p>
              </div>
            )}
            {info.connected && info.owner_jid && (
              <p className="wa-linked"><strong>Linked:</strong> {info.owner_jid.replace(/@.*/, '')}</p>
            )}
            <div className="wa-meta">
              <div><span className="wa-meta-k">Registered phones</span><span>{info.registered_phones ?? '—'}</span></div>
              <div><span className="wa-meta-k">Sidecar</span><span>{info.sidecar_url}</span></div>
              <div><span className="wa-meta-k">Portfolio gateway</span><span>{info.gateway_url}</span></div>
              <div><span className="wa-meta-k">Connector</span><span><code>{info.connector_id}</code></span></div>
            </div>
            {!info.connected && (
              <button className="primary" type="button" onClick={startLink} disabled={busy}>
                {busy ? 'Starting…' : 'Generate QR'}
              </button>
            )}
            {info.sidecar_error && <p className="err">{info.sidecar_error}</p>}
          </>
        )}
      </div>

      <div className="wa-card">
        <h2>Try on WhatsApp</h2>
        <ol className="wa-steps">
          <li>Save your number under <strong>Team</strong> (or the owner phone on this account).</li>
          <li>Scan the QR above with the phone that will host the bot (Linked devices).</li>
          <li>Include <strong>@</strong> in the message so the agent runs, e.g. <q>@ list KPIs for TMS</q> (Message yourself or a registered contact chat).</li>
        </ol>
      </div>
    </section>
  </>
  );
}

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const first = (name || '').split(' ')[0] || 'there';
  return `Good ${part}, ${first}`;
}

function longDate() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function Donut({ pct, color }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  const dash = (p / 100) * c;
  return (
    <svg className="donut" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={r} fill="none" stroke="#eceff2" strokeWidth="5" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="5"
        strokeDasharray={`${dash} ${c - dash}`}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}

const ROLE_COLORS = ['#234e86', '#e09a94', '#8fbfb6', '#c5c9d1', '#6d8cbf'];

function MonthGrid() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const start = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: start + count }, (_, i) => (i < start ? null : i - start + 1));
  const label = now.toLocaleDateString('en-US', { month: 'long' });
  return (
    <div className="cal">
      <div className="cal-head">{label}</div>
      <div className="cal-grid cal-dow">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={`${d}${i}`}>{d}</span>)}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => (
          <span key={i} className={d === today ? 'is-today' : ''}>{d || ''}</span>
        ))}
      </div>
    </div>
  );
}

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

function KpiDial({ kpis, submitted, focus, onFocus }) {
  const size = 520;
  const cx = 260;
  const cy = 260;
  const n = kpis.length;
  const active = kpis.find((k) => k.id === focus) ?? null;
  return (
    <svg className="dial" viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r="168" fill="none" stroke="#eef0f3" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="108" fill="none" stroke="#e7eaee" strokeWidth="1" strokeDasharray="2 5" />
      {Array.from({ length: 12 }, (_, i) => {
        const [x1, y1] = polar(cx, cy, 186, i * 30);
        const [x2, y2] = polar(cx, cy, 198, i * 30);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d7dbe2" strokeWidth="1.4" />;
      })}
      {kpis.map((k, i) => {
        const span = 360 / n;
        const gap = Math.min(12, span * 0.35);
        const a0 = i * span + gap / 2;
        const a1 = (i + 1) * span - gap / 2;
        const color = submitted.has(k.code) ? '#8fbfb6' : k.target != null ? '#234e86' : '#e09a94';
        const [lx, ly] = polar(cx, cy, 218, (a0 + a1) / 2);
        return (
          <g key={k.id} onMouseEnter={() => onFocus(k.id)} onMouseLeave={() => onFocus(null)}>
            <path d={arcPath(cx, cy, 164, a0, a1)} fill="none" stroke={color} strokeWidth={focus === k.id ? 18 : 13} strokeLinecap="round" />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="12" fill="#9aa1ab">{i + 1}</text>
          </g>
        );
      })}
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="16" fontWeight="600" fill="#1d1f24">
        {active ? active.name.slice(0, 24) : (n || '—')}
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="12" fill="#8d939c">
        {active ? (active.target == null ? 'No target' : `${active.target} ${active.unit}`) : 'measures'}
      </text>
    </svg>
  );
}
