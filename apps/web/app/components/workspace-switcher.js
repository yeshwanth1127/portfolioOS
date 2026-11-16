'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { ORGS_UPDATED_EVENT, readStoredSession, writeStoredOrgSlug, writeStoredSession } from '../lib/session.js';

function workspaceLabel(ws) {
  return ws?.name || ws?.slug || 'Workspace';
}

function initials(name) {
  return (name || 'W')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Workspace switcher (sidebar). A workspace is the customer boundary that holds organisations.
 * Lists the person's workspaces, switches between them (POST /auth/switch) and opens new ones
 * (POST /auth/workspaces). Both answer with a token for the target workspace.
 */
export default function WorkspaceSwitcher() {
  const listId = useId();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [token, setToken] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const session = readStoredSession();
    if (!session?.token) {
      setToken(null);
      setWorkspaces([]);
      setCurrentId(null);
      return;
    }
    setToken(session.token);
    try {
      const data = await api('/auth/workspaces', session.token);
      setWorkspaces(data.workspaces ?? []);
      setCurrentId(data.current ?? session.membership?.workspace_id ?? null);
      setError('');
    } catch (err) {
      setError(err.message);
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    load();
    const onStorage = (e) => {
      if (e.key === 'portfolio-os-session') load();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [load]);

  useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewName('');
      return undefined;
    }
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  if (!token) return null;

  const session = readStoredSession();
  const current =
    workspaces.find((w) => w.workspace_id === currentId) ??
    (currentId ? { workspace_id: currentId, name: session?.membership?.workspace_name ?? 'Workspace' } : null);
  const label = current ? workspaceLabel(current) : 'Workspace';

  /** Store the new workspace's session and reload into it. */
  function enter(data) {
    const prev = readStoredSession();
    writeStoredSession({ ...prev, token: data.token, membership: data.membership, workspaces: data.workspaces });
    writeStoredOrgSlug(data.membership?.org_slug ?? null);
    window.dispatchEvent(new CustomEvent(ORGS_UPDATED_EVENT));
    setOpen(false);
    return data;
  }

  async function switchTo(workspaceId) {
    if (workspaceId === currentId || busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/switch', readStoredSession().token, {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      enter(data);
      window.location.assign('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function createWorkspace(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/workspaces', readStoredSession().token, {
        method: 'POST',
        body: JSON.stringify({
          name: newName,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      enter(data);
      // A new workspace is empty: start by adding its first organisation.
      window.location.assign('/people?addOrg=1');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="workspace-switcher-avatar" aria-hidden>{initials(label)}</span>
        <span className="workspace-switcher-text">
          <span className="workspace-switcher-kicker">Workspace</span>
          <span className="workspace-switcher-label">{label}</span>
        </span>
        <span className="workspace-switcher-caret" aria-hidden />
      </button>

      {open && (
        <div className="workspace-switcher-menu" id={listId}>
          <p className="workspace-switcher-menu-title">Your workspaces</p>
          <ul role="listbox" aria-label="Workspaces">
            {workspaces.map((ws) => {
              const active = ws.workspace_id === currentId;
              return (
                <li key={ws.workspace_id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`workspace-switcher-item${active ? ' is-current' : ''}`}
                    disabled={busy || active}
                    onClick={() => switchTo(ws.workspace_id)}
                  >
                    <span className="workspace-switcher-avatar workspace-switcher-avatar-sm" aria-hidden>
                      {initials(workspaceLabel(ws))}
                    </span>
                    <span className="workspace-switcher-text">
                      <span className="workspace-switcher-item-name">{workspaceLabel(ws)}</span>
                      {ws.workspace_role ? <span className="workspace-switcher-item-role">{ws.workspace_role}</span> : null}
                    </span>
                    {active ? <span className="workspace-switcher-check" aria-hidden>✓</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="workspace-switcher-new">
            {creating ? (
              <form onSubmit={createWorkspace} className="workspace-switcher-form">
                <label className="workspace-switcher-form-label">
                  New workspace name
                  <input
                    ref={inputRef}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Acme Group"
                    minLength={2}
                    maxLength={80}
                    required
                  />
                </label>
                <p className="workspace-switcher-hint">You&apos;ll be its owner. Its people and data stay separate from this workspace.</p>
                <div className="workspace-switcher-form-actions">
                  <button type="button" className="quiet" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
                  <button type="submit" className="primary" disabled={busy || newName.trim().length < 2}>
                    {busy ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="workspace-switcher-add" onClick={() => setCreating(true)}>
                <span aria-hidden>+</span> New workspace
              </button>
            )}
          </div>
          {error ? <p className="workspace-switcher-error">{error}</p> : null}
        </div>
      )}
      {!open && error ? <p className="workspace-switcher-error">{error}</p> : null}
    </div>
  );
}
