'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../lib/api.js';

function InviteAcceptForm() {
  const searchParams = useSearchParams();
  const invitationId = searchParams.get('id') ?? '';
  const tokenFromQuery = searchParams.get('token') ?? '';
  const workspaceIdFromQuery = searchParams.get('workspace_id') ?? '';

  const [token, setToken] = useState(tokenFromQuery);
  const [workspaceId, setWorkspaceId] = useState(workspaceIdFromQuery);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess(null);
    if (!invitationId) {
      setError('Invitation id is missing from the link.');
      return;
    }
    if (!workspaceId || !token) {
      setError('workspace_id and token are required.');
      return;
    }
    setSubmitting(true);
    try {
      const data = await api(`/invitations/${invitationId}/accept`, null, {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: workspaceId,
          token,
          full_name: fullName,
          password: password || undefined,
          title: title || undefined,
        }),
      });
      setSuccess(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app app-in-shell">
      <div className="board">
        <div className="sheet">
          <header className="calendar-page-head">
            <h1>Accept invitation</h1>
            <p className="overview-muted m-0 text-sm">
              Set your name and password to join the workspace.
            </p>
          </header>

          {error ? <p className="err banner">{error}</p> : null}

          {success?.ok ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/90 p-4">
              <p className="m-0 font-semibold text-emerald-900">You&apos;re in.</p>
              <p className="overview-muted m-0 mt-2 text-sm">
                {success.can_sign_in
                  ? 'You can sign in on the home page with your email and password.'
                  : 'Your account was created without a password — ask your manager to reset access.'}
              </p>
              <p className="mt-3">
                <a href="/" className="linkish">
                  Go to sign in
                </a>
              </p>
            </div>
          ) : (
            <form className="inline mt-4 max-w-xl flex-col items-stretch gap-3" onSubmit={onSubmit}>
              <label>
                Invitation id
                <input value={invitationId} readOnly className="opacity-70" />
              </label>
              <label>
                Workspace id
                <input
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  required
                  placeholder="UUID from invite link"
                />
              </label>
              <label>
                Token
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  placeholder="Secret from invite link"
                />
              </label>
              <label>
                Full name
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </label>
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button className="primary" type="submit" disabled={submitting}>
                  {submitting ? 'Accepting…' : 'Accept invitation'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="app app-in-shell">
          <div className="board">
            <p className="overview-muted p-6">Loading…</p>
          </div>
        </div>
      }
    >
      <InviteAcceptForm />
    </Suspense>
  );
}
