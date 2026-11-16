'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import './landing.css';

/*
 * Logged-out home: the Orbit by Exora product page with sign-in and self-serve workspace
 * creation (POST /auth/signup). Hands a session to the parent through onSession.
 */

function OrbitMark({ size = 34 }) {
  return (
    <Image src="/exora-orbit-logo.png" alt="" width={size} height={size} priority className="ol-mark-img" />
  );
}

function Brand() {
  return (
    <a href="/" className="ol-brand" aria-label="Orbit by Exora">
      <OrbitMark />
      <span className="ol-brand-word">
        <span className="ol-brand-product">Orbit</span>
        <span className="ol-brand-by">by EXORA</span>
      </span>
    </a>
  );
}

const FEATURES = [
  {
    icon: 'grid',
    title: 'Every organisation, one view',
    body: 'Daily, weekly and monthly KPIs from every organisation scored against goal, so you see who is on track before the day ends.',
  },
  {
    icon: 'check',
    title: 'Numbers, validation, sign-off',
    body: 'Members record numbers, managers validate and close the day, and a closed day can’t be changed without reopening it. Every change is audited.',
  },
  {
    icon: 'chat',
    title: 'An agent on web and WhatsApp',
    body: 'Ask “how did TMS do this week?” or record a number by message. The same answer reaches the web chat and WhatsApp.',
  },
  {
    icon: 'flag',
    title: 'Projects and milestones',
    body: 'Projects, tasks, dependencies and a shared calendar sit beside the numbers they move.',
  },
  {
    icon: 'shield',
    title: 'Roles enforced in the database',
    body: 'Owner, manager, vice manager, team lead and member. Access is checked by row-level security, not just the screen.',
  },
  {
    icon: 'stack',
    title: 'Separate workspaces',
    body: 'Each business group gets its own workspace with its own people, data and WhatsApp line. Switch between them in one click.',
  },
];

function FeatureIcon({ name }) {
  const paths = {
    grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
    check: <><path d="M5 12.5l4 4 10-10" /></>,
    chat: <><path d="M5 18l1.2-3.6A7 7 0 1 1 9 17.4z" /></>,
    flag: <><path d="M6 21V4" /><path d="M6 4h11l-2 4 2 4H6" /></>,
    shield: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
    stack: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}

const PREVIEW_ORGS = [
  ['Academy', 92, 'good'],
  ['Studios', 81, 'good'],
  ['Logistics', 74, 'watch'],
  ['Retail', 68, 'watch'],
  ['Labs', 47, 'bad'],
];

function ProductPreview() {
  return (
    <div className="ol-preview" aria-hidden>
      <div className="ol-preview-bar">
        <span /><span /><span />
        <p>Sample workspace · Overview</p>
      </div>
      <div className="ol-preview-body">
        <aside className="ol-preview-side">
          <div className="ol-preview-ws">
            <OrbitMark size={18} />
            <b>Acme Group</b>
          </div>
          {['Overview', 'Today', 'Projects', 'Calendar', 'People', 'Agent'].map((l, i) => (
            <i key={l} className={i === 0 ? 'is-on' : ''}>{l}</i>
          ))}
        </aside>
        <div className="ol-preview-main">
          <div className="ol-preview-kpis">
            <div><small>On track</small><b>2 / 5</b></div>
            <div><small>Submitted today</small><b>86%</b></div>
            <div><small>Signed off</small><b>5</b></div>
          </div>
          <div className="ol-preview-rows">
            {PREVIEW_ORGS.map(([name, pct, tone]) => (
              <div key={name} className="ol-preview-row">
                <span>{name}</span>
                <span className="ol-preview-track"><span className={`ol-tone-${tone}`} style={{ width: `${pct}%` }} /></span>
                <span className={`ol-preview-pct ol-text-${tone}`}>{pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthCard({ mode, setMode, onSession, demoAccounts, demoHidden, initialEmail, initialPassword }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState(initialPassword);
  const [fullName, setFullName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data =
        mode === 'signin'
          ? await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ email, password }) })
          : await api('/auth/signup', null, {
              method: 'POST',
              body: JSON.stringify({
                full_name: fullName,
                email,
                password,
                workspace_name: workspaceName,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }),
            });
      onSession(data, { isNew: mode === 'signup' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ol-auth" id="get-started">
      <div className="ol-auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'is-on' : ''} onClick={() => { setMode('signin'); setError(''); }}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-on' : ''} onClick={() => { setMode('signup'); setError(''); }}>
          Create workspace
        </button>
      </div>

      <form onSubmit={submit} className="ol-auth-form">
        {mode === 'signup' ? (
          <>
            <p className="ol-auth-lede">Start a workspace for your group. You&apos;ll be its owner and can add organisations and people next.</p>
            <label>
              Workspace name
              <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="e.g. Acme Group" required minLength={2} />
            </label>
            <label>
              Your full name
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} />
            </label>
          </>
        ) : null}
        <label>
          Work email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'signup' ? 8 : undefined}
          />
        </label>
        {error ? <p className="ol-auth-err" role="alert">{error}</p> : null}
        <button className="ol-btn ol-btn-primary ol-btn-block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create workspace'}
        </button>
        <p className="ol-auth-switch">
          {mode === 'signin' ? (
            <>New to Orbit? <button type="button" onClick={() => setMode('signup')}>Create a workspace</button></>
          ) : (
            <>Already have an account? <button type="button" onClick={() => setMode('signin')}>Sign in</button></>
          )}
        </p>
      </form>

      {mode === 'signin' && !demoHidden && demoAccounts.length ? (
        <details className="ol-demo">
          <summary>Demo accounts · Sona Group workspace</summary>
          <div className="ol-demo-list">
            {demoAccounts.map(([name, role, mail, pw]) => (
              <button key={mail} type="button" onClick={() => { setEmail(mail); setPassword(pw); }}>
                <span>{name}</span>
                <small>{role}</small>
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export default function Landing({ onSession, notice, demoAccounts = [], demoHidden = false, initialEmail = '', initialPassword = '' }) {
  const [mode, setMode] = useState('signin');
  const authRef = useRef(null);

  function start(nextMode) {
    setMode(nextMode);
    authRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <div className="ol-page">
      <header className="ol-nav">
        <div className="ol-wrap ol-nav-inner">
          <Brand />
          <nav className="ol-nav-links" aria-label="Sections">
            <a href="#product">Product</a>
            <a href="#workspaces">Workspaces</a>
            <a href="#agent">Agent</a>
            <a href="#plans">Plans</a>
          </nav>
          <div className="ol-nav-cta">
            <button type="button" className="ol-btn ol-btn-ghost" onClick={() => start('signin')}>Sign in</button>
            <button type="button" className="ol-btn ol-btn-primary" onClick={() => start('signup')}>Get started</button>
          </div>
        </div>
      </header>

      <main>
        <section className="ol-hero">
          <div className="ol-orbit-bg" aria-hidden><span /><span /><span /></div>
          <div className="ol-wrap ol-hero-grid">
            <div className="ol-hero-copy">
              <p className="ol-eyebrow">Portfolio operations platform</p>
              <h1>Run every organisation in your group from one orbit.</h1>
              <p className="ol-hero-sub">
                Orbit brings each organisation&apos;s daily numbers, goals, projects and people into one workspace,
                with an agent you can ask on the web or on WhatsApp.
              </p>
              <div className="ol-hero-actions">
                <button type="button" className="ol-btn ol-btn-primary ol-btn-lg" onClick={() => start('signup')}>Create your workspace</button>
                <a href="#product" className="ol-btn ol-btn-ghost ol-btn-lg">See how it works</a>
              </div>
              <ul className="ol-hero-points">
                <li>Isolated workspace per group</li>
                <li>Web + WhatsApp</li>
                <li>Role-based access</li>
              </ul>
            </div>
            <div ref={authRef}>
              {notice ? <p className="ol-notice">{notice}</p> : null}
              <AuthCard
                mode={mode}
                setMode={setMode}
                onSession={onSession}
                demoAccounts={demoAccounts}
                demoHidden={demoHidden}
                initialEmail={initialEmail}
                initialPassword={initialPassword}
              />
            </div>
          </div>
        </section>

        <section className="ol-section ol-preview-section">
          <div className="ol-wrap">
            <ProductPreview />
            <p className="ol-caption">Illustration with sample data.</p>
          </div>
        </section>

        <section className="ol-section" id="product">
          <div className="ol-wrap">
            <p className="ol-eyebrow">Product</p>
            <h2>Everything a group owner checks each day, in one place.</h2>
            <div className="ol-features">
              {FEATURES.map((f) => (
                <article key={f.title} className="ol-feature">
                  <span className="ol-feature-icon"><FeatureIcon name={f.icon} /></span>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="ol-section ol-section-tint" id="workspaces">
          <div className="ol-wrap ol-split">
            <div>
              <p className="ol-eyebrow">Workspaces</p>
              <h2>One workspace per group. Organisations inside it.</h2>
              <p className="ol-lede">
                A workspace is a hard boundary: its people, numbers and conversations never mix with another
                workspace&apos;s. Inside it, each organisation has its own manager, teams and KPIs, and the owner sees them all.
              </p>
              <ol className="ol-steps">
                <li><b>Create a workspace</b><span>Name it after your group. You become the owner.</span></li>
                <li><b>Add organisations</b><span>One for each business, with its sector and manager.</span></li>
                <li><b>Invite people and set goals</b><span>Managers and team leads take it from there.</span></li>
              </ol>
            </div>
            <div className="ol-tree" aria-label="Example workspace structure">
              <div className="ol-tree-ws">
                <OrbitMark size={22} />
                <div><b>Sona Group</b><small>Workspace · owner Thyagu Sir</small></div>
              </div>
              <ul>
                {['TMS', 'Unreal', 'Sonastar3Dx', 'PATS', 'SAI', 'Communications', 'SCALE'].map((o) => (
                  <li key={o}><span className="ol-tree-dot" />{o}<small>Organisation</small></li>
                ))}
              </ul>
              <div className="ol-tree-ws ol-tree-ws-new">
                <span className="ol-tree-plus">+</span>
                <div><b>Your next workspace</b><small>Separate people, data and WhatsApp line</small></div>
              </div>
            </div>
          </div>
        </section>

        <section className="ol-section" id="agent">
          <div className="ol-wrap ol-split ol-split-rev">
            <div className="ol-chat" aria-hidden>
              <div className="ol-chat-head"><OrbitMark size={22} /><b>Orbit agent</b><small>WhatsApp</small></div>
              <p className="ol-chat-msg ol-chat-me">How is Labs doing this week?</p>
              <p className="ol-chat-msg">
                Labs is at <b className="ol-text-bad">47%</b> of its weekly goal. Enquiries are behind by 12; revenue is on track.
                Yesterday has not been signed off yet.
              </p>
              <p className="ol-chat-msg ol-chat-me">Log 6 enquiries for Labs today.</p>
              <p className="ol-chat-msg">Done. 6 enquiries recorded for Labs today, waiting for the manager to validate.</p>
            </div>
            <div>
              <p className="ol-eyebrow">Agent</p>
              <h2>Ask, record and follow up by message.</h2>
              <p className="ol-lede">
                The Orbit agent, built on EXORA&apos;s Qlix, answers questions about your numbers and records new ones.
                It acts with the same permissions as the person asking, so a team lead can only touch their own team.
              </p>
            </div>
          </div>
        </section>

        <section className="ol-section ol-section-tint" id="plans">
          <div className="ol-wrap">
            <p className="ol-eyebrow">Plans</p>
            <h2>Start with a pilot. Grow into the full platform.</h2>
            <div className="ol-plans">
              <article className="ol-plan ol-plan-main">
                <h3>Pilot</h3>
                <p className="ol-plan-tag">Every new workspace starts here</p>
                <ul>
                  <li>Dashboards and daily scoring</li>
                  <li>Web and WhatsApp agent</li>
                  <li>Projects, milestones and calendar</li>
                  <li>CSV onboarding and data export</li>
                </ul>
                <button type="button" className="ol-btn ol-btn-primary ol-btn-block" onClick={() => start('signup')}>Create workspace</button>
              </article>
              <article className="ol-plan">
                <h3>Enterprise</h3>
                <p className="ol-plan-tag">For groups with many organisations</p>
                <ul>
                  <li>Several workspaces under one account</li>
                  <li>Dedicated WhatsApp line per workspace</li>
                  <li>Custom KPIs and integrations, set up by EXORA engineers</li>
                  <li>Priority support</li>
                </ul>
                <a className="ol-btn ol-btn-ghost ol-btn-block" href="mailto:support@exora.solutions?subject=Orbit%20Enterprise">Talk to us</a>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="ol-footer">
        <div className="ol-wrap ol-footer-inner">
          <Brand />
          <p>© {new Date().getFullYear()} EXORA Solutions Pvt. Ltd. · Bengaluru · <a href="mailto:support@exora.solutions">support@exora.solutions</a></p>
        </div>
      </footer>
    </div>
  );
}
