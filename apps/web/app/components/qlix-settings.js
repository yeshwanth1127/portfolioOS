'use client';

import { useCallback, useEffect, useState } from 'react';

const STATUS = {
  active: { label: 'Connected', tone: 'ok' },
  pending: { label: 'Setting up', tone: 'warn' },
  waiting_link: { label: 'Waiting for you in Qlix', tone: 'warn' },
  paused: { label: 'Disconnected', tone: 'bad' },
  failed: { label: 'Setup failed', tone: 'bad' },
  disabled: { label: 'Turned off', tone: 'warn' },
  not_started: { label: 'Not set up', tone: 'warn' },
};

const INVITE_LABEL = {
  pending: 'Sign-in link sent, not used yet',
  accepted: 'Active',
  expired: 'Sign-in link expired',
  revoked: 'Sign-in link replaced',
};

function when(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Owner: the workspace's Qlix login — email, password (hidden until shown), change password. */
function QlixLogin({ info, session, api, onChanged }) {
  const login = info.login;
  const [revealed, setRevealed] = useState(null); // { email, password }
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  async function reveal() {
    setBusy('show');
    setError('');
    try {
      const out = await api('/qlix/login', session.token);
      setRevealed(out);
      setShow(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function save(generate) {
    setBusy('save');
    setError('');
    try {
      const out = await api('/qlix/login/password', session.token, {
        method: 'POST',
        body: JSON.stringify({ password: generate ? '' : draft }),
      });
      setRevealed(out);
      setShow(true);
      setEditing(false);
      setDraft('');
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function copyField(kind, text) {
    if (await copy(text)) {
      setCopied(kind);
      setTimeout(() => setCopied(''), 1500);
    }
  }

  const managed = login.managed_by_orbit;
  const password = revealed?.password ?? null;

  return (
    <div className="qlix-login">
      <h3>Qlix login</h3>
      <p className="muted qlix-login-lead">
        Sign in at {info.console_url ? <code>{info.console_url}</code> : 'Qlix'} with these details to see your agents,
        their runs and usage.
      </p>
      <dl className="qlix-login-rows">
        <div>
          <dt>Email</dt>
          <dd>
            <code>{login.email}</code>
            <button type="button" className="linkish" onClick={() => copyField('email', login.email)}>
              {copied === 'email' ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>
            {!managed ? (
              <span className="muted">Your own Qlix password. Change it in Qlix.</span>
            ) : !login.password_known && !password ? (
              <span className="muted">Chosen by you in Qlix, so Orbit can't show it. Set a new one below to see it here.</span>
            ) : (
              <>
                <code>{show && password ? password : '••••••••••••'}</code>
                {show && password ? (
                  <>
                    <button type="button" className="linkish" onClick={() => setShow(false)}>Hide</button>
                    <button type="button" className="linkish" onClick={() => copyField('password', password)}>
                      {copied === 'password' ? 'Copied' : 'Copy'}
                    </button>
                  </>
                ) : (
                  <button type="button" className="linkish" onClick={password ? () => setShow(true) : reveal} disabled={Boolean(busy)}>
                    {busy === 'show' ? 'Loading…' : 'Show'}
                  </button>
                )}
              </>
            )}
          </dd>
        </div>
        {managed && login.password_set_at ? (
          <div>
            <dt>Last changed</dt>
            <dd>{when(revealed?.password_set_at ?? login.password_set_at)}</dd>
          </div>
        ) : null}
      </dl>

      {managed && info.owner_invite && info.owner_invite.status !== 'accepted' ? (
        <p className="muted qlix-login-note">Open your Qlix sign-in link first; then you can set the password here.</p>
      ) : managed ? (
        editing ? (
          <form
            className="qlix-password-form"
            onSubmit={(e) => {
              e.preventDefault();
              save(false);
            }}
          >
            <label htmlFor="qlix-new-password">New Qlix password</label>
            <input
              id="qlix-new-password"
              type="text"
              autoComplete="new-password"
              minLength={12}
              maxLength={72}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="12 to 72 characters"
            />
            <div className="wa-actions">
              <button type="submit" className="quiet" disabled={Boolean(busy) || draft.length < 12}>
                {busy === 'save' ? 'Saving…' : 'Save password'}
              </button>
              <button type="button" className="quiet" onClick={() => save(true)} disabled={Boolean(busy)}>
                Generate one for me
              </button>
              <button type="button" className="quiet" onClick={() => { setEditing(false); setDraft(''); setError(''); }}>
                Cancel
              </button>
            </div>
            <p className="muted qlix-login-note">
              Saving signs this login out of Qlix everywhere, including the Orbit page inside Qlix. Sign in again with the
              new password.
            </p>
          </form>
        ) : (
          <div className="wa-actions">
            <button type="button" className="quiet" onClick={() => setEditing(true)} disabled={Boolean(busy)}>
              {login.password_known || password ? 'Change password' : 'Set a password'}
            </button>
          </div>
        )
      ) : null}

      {error ? <p className="wa-error">{error}</p> : null}
    </div>
  );
}

/** Owner: this workspace's Qlix org and its two agents (Settings tab). */
export default function QlixSettingsPanel({ session, api }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!session?.token) return;
    try {
      setInfo(await api('/qlix/status', session.token));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [api, session?.token]);

  useEffect(() => {
    load();
  }, [load]);

  // While setup runs, or while waiting for the plugin to be turned on in Qlix, check again.
  useEffect(() => {
    if (!['pending', 'waiting_link'].includes(info?.status)) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [info?.status, load]);

  async function retry() {
    setBusy('retry');
    setError('');
    try {
      setInfo(await api('/qlix/retry', session.token, { method: 'POST' }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function getLogin() {
    setBusy('invite');
    setError('');
    setCopied(false);
    try {
      const out = await api('/qlix/invite-owner', session.token, { method: 'POST' });
      if (out.invite_url) setInvite(out);
      else if (out.message) setError(out.message);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  const state = STATUS[info?.status] ?? STATUS.not_started;
  const ownerInvite = info?.owner_invite;
  const canInvite = info?.status === 'active' && info?.link_mode !== 'linked' && ownerInvite?.status !== 'accepted';

  return (
    <section className="settings-block qlix-settings">
      <div className="settings-panel">
        <div className="settings-block-head">
          <h2>Qlix agents</h2>
          {info ? <span className={`tag ${state.tone}`}>{state.label}</span> : null}
        </div>

        {!info && !error ? <p className="muted">Loading…</p> : null}

        {info && !info.configured ? (
          <p className="muted wa-lead">
            Qlix is not configured on this server. Set <code>QLIX_BACKEND_URL</code> and{' '}
            <code>QLIX_PARTNER_KEY</code>, then retry.
          </p>
        ) : null}

        {info?.configured && info.status === 'waiting_link' ? (
          <div className="qlix-callout">
            <p>
              <strong>You already use Qlix.</strong> Open Qlix and turn on Orbit to connect this workspace to your existing
              organisation{info.waiting_email ? ` (${info.waiting_email})` : ''}. Only an owner or admin of that Qlix
              organisation can turn it on. This page updates by itself when it connects.
            </p>
            {info.connect_url ? (
              <a className="quiet" href={info.connect_url} target="_blank" rel="noopener noreferrer">
                Open Qlix
              </a>
            ) : null}
          </div>
        ) : null}

        {info?.configured && info.status === 'paused' ? (
          <div className="qlix-callout">
            <p>
              <strong>Qlix is disconnected.</strong> Orbit was turned off in your Qlix organisation, so the assistant and
              report summaries are paused. Nothing was deleted: turn it back on in Qlix to reconnect.
            </p>
            {info.console_url ? (
              <a className="quiet" href={info.console_url} target="_blank" rel="noopener noreferrer">
                Open Qlix
              </a>
            ) : null}
          </div>
        ) : null}

        {info?.configured && !['waiting_link', 'paused'].includes(info.status) ? (
          <>
            <p className="muted wa-lead">
              {info.link_mode === 'linked'
                ? 'Connected to your existing Qlix organisation through the Orbit plugin.'
                : 'Orbit created a Qlix organisation for this workspace.'}{' '}
              The agents read your data only through Orbit, as the person asking. Every conversation and report summary is
              recorded in Qlix as a run.
            </p>
            <dl className="qlix-facts">
              <div>
                <dt>Qlix organisation</dt>
                <dd>
                  <strong>{info.org_name ?? '—'}</strong>
                  {info.org_id ? <small><code>{info.org_id}</code></small> : null}
                </dd>
              </div>
              {info.agents.map((a) => (
                <div key={a.kind}>
                  <dt>{a.name}</dt>
                  <dd>
                    <span>{a.purpose}</span>
                    {a.id ? <small><code>{a.id}</code></small> : <small>Not created yet</small>}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}

        {info?.status === 'active' && info.login ? (
          <QlixLogin info={info} session={session} api={api} onChanged={load} />
        ) : null}

        {invite ? (
          <div className="qlix-callout">
            <p>
              <strong>Your Qlix sign-in link</strong> for {invite.email}. It is shown only once and works for 7 days. Open
              it on this computer to create your Qlix login.
            </p>
            <p className="qlix-link">
              <code>{invite.invite_url}</code>
            </p>
            <div className="wa-actions">
              <a className="quiet" href={invite.invite_url} target="_blank" rel="noopener noreferrer">
                Open link
              </a>
              <button
                type="button"
                className="quiet"
                onClick={async () => setCopied(await copy(invite.invite_url))}
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
        ) : null}

        {info?.status === 'active' && ownerInvite && ownerInvite.status !== 'accepted' && !invite ? (
          <p className="muted qlix-login-note">Qlix login: {INVITE_LABEL[ownerInvite.status] ?? ownerInvite.status}.</p>
        ) : null}

        {info?.last_error ? <p className="wa-error">Last error: {info.last_error}</p> : null}
        {error ? <p className="wa-error">{error}</p> : null}

        {info?.configured ? (
          <div className="wa-actions">
            {['failed', 'pending', 'not_started'].includes(info.status) ? (
              <button type="button" className="quiet" onClick={retry} disabled={Boolean(busy)}>
                {busy === 'retry' ? 'Starting…' : info.status === 'failed' ? 'Try again' : 'Set up now'}
              </button>
            ) : null}
            {canInvite ? (
              <button type="button" className="quiet" onClick={getLogin} disabled={Boolean(busy)}>
                {busy === 'invite'
                  ? 'Getting link…'
                  : ownerInvite?.status === 'pending' || ownerInvite?.status === 'expired'
                    ? 'Get a new Qlix sign-in link'
                    : 'Get my Qlix login'}
              </button>
            ) : null}
            {info.console_url && info.status === 'active' ? (
              <a className="quiet" href={info.console_url} target="_blank" rel="noopener noreferrer">
                Open Qlix
              </a>
            ) : null}
            <button type="button" className="quiet" onClick={load} disabled={Boolean(busy)}>
              Refresh
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
