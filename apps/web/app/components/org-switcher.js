'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  ORG_CHANGE_EVENT,
  ORGS_UPDATED_EVENT,
  readStoredOrgSlug,
  readStoredSession,
  writeStoredOrgSlug,
} from '../lib/session.js';

function orgLabel(org) {
  return org?.short_name || org?.name || org?.slug || 'Organisation';
}

export default function OrgSwitcher() {
  const listId = useId();
  const rootRef = useRef(null);
  const [token, setToken] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [slug, setSlug] = useState(() => readStoredOrgSlug());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const session = readStoredSession();
    if (!session?.token) {
      setToken(null);
      setOrgs([]);
      return;
    }
    setToken(session.token);
    setSlug(readStoredOrgSlug());
    setLoading(true);
    try {
      const data = await api('/orgs', session.token);
      const list = data.orgs ?? [];
      setOrgs(list);
      let next = readStoredOrgSlug();
      if (!next && list[0]) {
        next = list[0].slug;
        writeStoredOrgSlug(next);
        window.dispatchEvent(new CustomEvent(ORG_CHANGE_EVENT, { detail: { slug: next } }));
      }
      setSlug(next);
    } catch {
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const onSession = (e) => {
      if (e.key === 'portfolio-os-session') load();
    };
    const onOrg = () => setSlug(readStoredOrgSlug());
    window.addEventListener('storage', onSession);
    window.addEventListener(ORG_CHANGE_EVENT, onOrg);
    window.addEventListener(ORGS_UPDATED_EVENT, load);
    return () => {
      window.removeEventListener('storage', onSession);
      window.removeEventListener(ORG_CHANGE_EVENT, onOrg);
      window.removeEventListener(ORGS_UPDATED_EVENT, load);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!token) return null;

  const current = orgs.find((o) => o.slug === slug) ?? orgs[0] ?? null;
  const label = loading && !current ? 'Loading…' : orgLabel(current);
  const multi = orgs.length > 1;
  const isOwner = readStoredSession()?.membership?.role === 'owner';

  function pick(nextSlug) {
    if (!nextSlug || nextSlug === slug) return;
    writeStoredOrgSlug(nextSlug);
    setSlug(nextSlug);
    setOpen(false);
    window.dispatchEvent(new CustomEvent(ORG_CHANGE_EVENT, { detail: { slug: nextSlug } }));
  }

  if (!orgs.length && !loading) {
    return (
      <div className="org-switcher org-switcher-empty">
        <p className="org-switcher-empty-label">No organisation</p>
        {isOwner ? (
          <Link href="/people?addOrg=1" className="org-switcher-add" onClick={() => setOpen(false)}>
            Add organisation
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="org-switcher" ref={rootRef}>
      {multi ? (
        <>
          <button
            type="button"
            className="org-switcher-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="org-switcher-label">{label}</span>
            <span className="workspace-switcher-caret" aria-hidden />
          </button>
          {open && (
            <ul className="org-switcher-menu workspace-switcher-menu" id={listId} role="listbox" aria-label="Organisations">
              {orgs.map((org) => {
                const active = org.slug === slug;
                return (
                  <li key={org.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={active ? 'is-current' : ''}
                      disabled={active}
                      onClick={() => pick(org.slug)}
                    >
                      <span className="workspace-switcher-item-name">{orgLabel(org)}</span>
                      {org.slug !== orgLabel(org) ? (
                        <span className="workspace-switcher-item-role">{org.slug}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {isOwner ? (
                <li role="presentation" className="org-switcher-menu-footer">
                  <Link href="/people?addOrg=1" className="org-switcher-add" onClick={() => setOpen(false)}>
                    + Add organisation
                  </Link>
                </li>
              ) : null}
            </ul>
          )}
        </>
      ) : (
        <div className="org-switcher-trigger org-switcher-single" title={current?.slug}>
          <span className="org-switcher-label">{label}</span>
        </div>
      )}
    </div>
  );
}
