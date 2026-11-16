'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * The bell in the top bar: your in-app notifications (GET /notifications), polled every 20 s
 * and when the tab comes back. Meeting invites carry a Join button while the meeting can be
 * joined, and when someone starts a meeting with you a pop-up offers to join straight away.
 */
const POLL_MS = 20000;
export const MEETINGS_CHANGED = 'orbit:meetings-changed';

function ago(at) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** A meeting notification can be joined while its meeting is live, or about to start. */
function joinable(n) {
  if (!n.meeting_id || !n.meeting_status || n.meeting_status === 'ended') return false;
  if (n.meeting_status === 'live') return true;
  return new Date(n.meeting_starts_at).getTime() - Date.now() < 15 * 60000;
}

export default function NotificationBell({ token }) {
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [popup, setPopup] = useState(null);
  const seen = useRef(null); // ids seen so far (null until the first load)
  const box = useRef(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api('/notifications?limit=30', token);
      setItems(data.notifications ?? []);
      setUnread(data.unread ?? 0);
      const ids = new Set((data.notifications ?? []).map((n) => n.id));
      if (seen.current) {
        const added = (data.notifications ?? []).filter((n) => !seen.current.has(n.id));
        const fresh = added.find((n) => !n.read_at && n.kind === 'meeting_started' && joinable(n));
        if (fresh) setPopup(fresh);
        // Pages that list meetings refresh when an invite (or cancellation) arrives.
        if (added.some((n) => n.kind.startsWith('meeting'))) window.dispatchEvent(new Event(MEETINGS_CHANGED));
      }
      seen.current = ids;
    } catch {
      /* offline or signed out: try again on the next tick */
    }
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    load();
    const t = setInterval(load, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, load]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function markRead(ids) {
    const body = ids === 'all' ? { all: true } : { ids };
    setItems((list) => list.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)));
    try {
      const data = await api('/notifications/read', token, { method: 'POST', body: JSON.stringify(body) });
      setUnread(data.unread ?? 0);
    } catch {
      load();
    }
  }

  function go(n, { join = false } = {}) {
    if (!n.read_at) markRead([n.id]);
    setOpen(false);
    setPopup(null);
    const target = join && n.meeting_id ? `/meetings/${n.meeting_id}?join=1` : n.link;
    if (target) router.push(target);
  }

  if (!token) return null;

  return (
    <div className="nb" ref={box}>
      <button
        type="button"
        className="pw-notify"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
          <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0v1a3 3 0 0 1-6 0v-1" />
        </svg>
        {unread ? <span className="nb-badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>

      {open ? (
        <div className="nb-panel" role="dialog" aria-label="Notifications">
          <div className="nb-head">
            <b>Notifications</b>
            {unread ? (
              <button type="button" className="nb-link" onClick={() => markRead('all')}>Mark all as read</button>
            ) : null}
          </div>
          {items.length ? (
            <ul className="nb-list">
              {items.map((n) => (
                <li key={n.id} className={n.read_at ? '' : 'is-unread'}>
                  <button type="button" className="nb-item" onClick={() => go(n)} disabled={!n.link && !!n.read_at}>
                    <span className={`nb-icon nb-icon-${n.kind.startsWith('meeting') ? 'meeting' : 'other'}`} aria-hidden>
                      {n.kind.startsWith('meeting') ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10 5-3v10l-5-3" /></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></svg>
                      )}
                    </span>
                    <span className="nb-text">
                      <span>{n.body}</span>
                      <small>{ago(n.created_at)}</small>
                    </span>
                  </button>
                  {joinable(n) ? (
                    <button type="button" className="primary nb-join" onClick={() => go(n, { join: true })}>Join</button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="nb-empty">You’re all caught up.</p>
          )}
        </div>
      ) : null}

      {popup ? (
        <div className="nb-popup" role="alertdialog" aria-label="Meeting started">
          <span className="nb-icon nb-icon-meeting" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10 5-3v10l-5-3" /></svg>
          </span>
          <p>{popup.body}</p>
          <div className="nb-popup-actions">
            <button type="button" className="quiet" onClick={() => { markRead([popup.id]); setPopup(null); }}>Not now</button>
            <button type="button" className="primary" onClick={() => go(popup, { join: true })}>Join</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
