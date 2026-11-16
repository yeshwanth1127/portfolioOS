'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { initials } from '../lib/meetings.js';

/**
 * "Who is this meeting with?" — pick people, whole teams, or whole organisations, from
 * GET /meetings/invitees (only what the signed-in person can see). The value is
 * { participant_ids, team_ids, org_ids }; the server expands teams and organisations.
 */
export const emptyInvitees = () => ({ participant_ids: [], team_ids: [], org_ids: [] });

export function inviteeCount(value) {
  return value.participant_ids.length + value.team_ids.length + value.org_ids.length;
}

export function useInviteDirectory(token) {
  const [dir, setDir] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    let live = true;
    api('/meetings/invitees', token)
      .then((d) => live && setDir(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [token]);
  return { dir, error };
}

const KEY = { people: 'participant_ids', teams: 'team_ids', orgs: 'org_ids' };

export default function InvitePicker({ dir, error, value, onChange, exclude = [] }) {
  const [tab, setTab] = useState('people');
  const [q, setQ] = useState('');

  const skip = useMemo(() => new Set(exclude), [exclude]);
  const people = useMemo(() => (dir?.people ?? []).filter((p) => !skip.has(p.id)), [dir, skip]);
  const teams = dir?.teams ?? [];
  const orgs = dir?.orgs ?? [];
  const personById = useMemo(() => new Map((dir?.people ?? []).map((p) => [p.id, p])), [dir]);

  // Everyone the current choice reaches, so the count is people, not picks.
  const reached = useMemo(() => {
    const out = new Set(value.participant_ids);
    for (const t of teams) if (value.team_ids.includes(t.id)) t.member_ids.forEach((id) => out.add(id));
    for (const o of orgs) if (value.org_ids.includes(o.id)) o.member_ids.forEach((id) => out.add(id));
    for (const id of exclude) out.delete(id);
    return out;
  }, [value, teams, orgs, exclude]);

  if (error) return <p className="err">{error}</p>;
  if (!dir) return <p className="mt-hint">Loading people…</p>;

  const needle = q.trim().toLowerCase();
  const match = (text) => !needle || text.toLowerCase().includes(needle);
  const rows = {
    people: people
      .filter((p) => match(`${p.full_name} ${p.title ?? ''} ${p.org ?? ''}`))
      .map((p) => ({ id: p.id, label: p.full_name, sub: [p.title, p.org].filter(Boolean).join(' · '), avatar: initials(p.full_name) })),
    teams: teams
      .filter((t) => match(`${t.name} ${t.org ?? ''}`))
      .map((t) => ({ id: t.id, label: t.name, sub: `${t.member_ids.length} ${t.member_ids.length === 1 ? 'person' : 'people'}${t.org ? ` · ${t.org}` : ''}`, avatar: initials(t.name) })),
    orgs: orgs
      .filter((o) => match(`${o.name} ${o.short_name ?? ''}`))
      .map((o) => ({
        id: o.id,
        label: o.name,
        sub: o.member_ids.length ? `Everyone · ${o.member_ids.length} ${o.member_ids.length === 1 ? 'person' : 'people'}` : 'No one to invite here yet',
        avatar: initials(o.short_name || o.name),
        empty: !o.member_ids.length,
      })),
  };
  const tabs = [
    { value: 'people', label: 'People', n: people.length },
    { value: 'teams', label: 'Teams', n: teams.length },
    ...(orgs.length ? [{ value: 'orgs', label: orgs.length > 1 ? 'Organisations' : 'Organisation', n: orgs.length }] : []),
  ].filter((t) => t.n);

  const toggle = (kind, id) => {
    const key = KEY[kind];
    const has = value[key].includes(id);
    onChange({ ...value, [key]: has ? value[key].filter((x) => x !== id) : [...value[key], id] });
  };

  const chips = [
    ...value.org_ids.map((id) => ({ kind: 'orgs', id, label: orgs.find((o) => o.id === id)?.name ?? 'Organisation' })),
    ...value.team_ids.map((id) => ({ kind: 'teams', id, label: teams.find((t) => t.id === id)?.name ?? 'Team' })),
    ...value.participant_ids.map((id) => ({ kind: 'people', id, label: personById.get(id)?.full_name ?? 'Someone' })),
  ];

  if (!tabs.length) return <p className="mt-hint">There’s no one else in your workspace you can invite yet.</p>;
  const active = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;

  return (
    <div className="mt-picker">
      <div className="mt-picker-bar">
        <div className="mt-seg" role="tablist" aria-label="Invite by">
          {tabs.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={active === t.value} className={active === t.value ? 'on' : ''} onClick={() => { setTab(t.value); setQ(''); }}>
              {t.label}
            </button>
          ))}
        </div>
        <input className="mt-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tabs.find((t) => t.value === active)?.label.toLowerCase()}`} aria-label="Search" />
      </div>

      {chips.length ? (
        <div className="mt-chips" aria-label="Invited">
          {chips.map((c) => (
            <span key={`${c.kind}:${c.id}`} className={`mt-chip-pick mt-chip-${c.kind}`}>
              {c.label}
              <button type="button" aria-label={`Remove ${c.label}`} onClick={() => toggle(c.kind, c.id)}>×</button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-people">
        {rows[active].length ? (
          rows[active].map((r) => {
            const on = value[KEY[active]].includes(r.id);
            const viaGroup = active === 'people' && !on && reached.has(r.id);
            const disabled = viaGroup || (r.empty && !on);
            return (
              <button type="button" key={r.id} className={`mt-person${on || viaGroup ? ' is-on' : ''}${viaGroup ? ' is-via' : ''}${r.empty ? ' is-empty' : ''}`} onClick={() => toggle(active, r.id)} aria-pressed={on} disabled={disabled}>
                <span className={`mt-avatar${active !== 'people' ? ' is-group' : ''}`} aria-hidden>{r.avatar}</span>
                <span className="mt-person-text">
                  <b>{r.label}</b>
                  {viaGroup ? <small>Invited with a team</small> : r.sub ? <small>{r.sub}</small> : null}
                </span>
              </button>
            );
          })
        ) : (
          <p className="mt-hint">No match for “{q}”.</p>
        )}
      </div>

      <p className="mt-hint mt-reach">
        {reached.size
          ? `${reached.size} ${reached.size === 1 ? 'person' : 'people'} will be invited and notified.`
          : 'Pick at least one person, team or organisation.'}
      </p>
    </div>
  );
}
