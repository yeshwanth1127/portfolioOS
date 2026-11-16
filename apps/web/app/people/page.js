'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { ORG_CHANGE_EVENT, readStoredOrgSlug, readStoredSession } from '../lib/session.js';
import UnitStructure from '../components/unit-structure.js';

/** People: add someone in three steps (details → role → reports to), then everyone in the org below. */

const ROLES = [
  { value: 'member', label: 'Member', hint: 'Sends their own numbers' },
  { value: 'team_lead', label: 'Team lead', hint: 'Leads a few members and checks their numbers' },
  { value: 'vice_manager', label: 'Vice manager', hint: 'Helps the manager run the organisation' },
  { value: 'manager', label: 'Manager', hint: 'Runs the organisation · one per organisation' },
];
const ROLE_LABEL = { owner: 'Owner', ...Object.fromEntries(ROLES.map((r) => [r.value, r.label])) };
const LEADER_ROLES = ['manager', 'vice_manager', 'team_lead'];

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'manager', label: 'Managers' },
  { value: 'team_lead', label: 'Team leads' },
  { value: 'member', label: 'Members' },
];

const EMPTY = { full_name: '', email: '', phone_e164: '', title: '', password: '', role: null, parent_id: '' };

export default function PeoplePage() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);
  const [session, setSession] = useState(null);
  const [orgSlug, setOrgSlug] = useState(null);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [orgName, setOrgName] = useState('');

  // Flow state
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const flowRef = useRef(null);

  // List state
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setMounted(true);
    const s = readStoredSession();
    setSession(s);
    const sync = () => setOrgSlug(readStoredOrgSlug() || s?.membership?.org_slug || null);
    sync();
    window.addEventListener(ORG_CHANGE_EVENT, sync);
    return () => window.removeEventListener(ORG_CHANGE_EVENT, sync);
  }, []);

  const membership = session?.membership;
  const isOwner = membership?.role === 'owner';
  const canManage = Boolean(membership && ['owner', 'manager', 'vice_manager'].includes(membership.role));
  const canEditStructure = Boolean(membership && ['owner', 'manager'].includes(membership.role));
  const allowedRoles = isOwner ? ROLES.map((r) => r.value) : ['member', 'vice_manager'];

  const load = useCallback(async () => {
    if (!session?.token || !orgSlug) {
      setPeople([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [data, orgs] = await Promise.all([
        api(`/orgs/${orgSlug}/people`, session.token),
        api('/orgs', session.token).catch(() => ({ orgs: [] })),
      ]);
      setPeople(data.people ?? []);
      const org = (orgs.orgs ?? []).find((o) => o.slug === orgSlug);
      setOrgName(org?.short_name || org?.name || orgSlug);
    } catch (err) {
      setError(err.message);
      setPeople([]);
    } finally {
      setLoading(false);
    }
  }, [session, orgSlug]);

  useEffect(() => {
    load();
  }, [load]);

  const byId = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);
  const existingManager = people.find((p) => p.role === 'manager');
  const leaders = people.filter((p) => LEADER_ROLES.includes(p.role) && p.id !== editingId);
  const editing = editingId ? byId[editingId] : null;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter((p) => {
      if (filter === 'manager' && !['manager', 'vice_manager'].includes(p.role)) return false;
      if (filter !== 'all' && filter !== 'manager' && p.role !== filter) return false;
      if (q && !`${p.full_name} ${p.title ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [people, filter, search]);

  const counts = useMemo(
    () => ({
      all: people.length,
      manager: people.filter((p) => ['manager', 'vice_manager'].includes(p.role)).length,
      team_lead: people.filter((p) => p.role === 'team_lead').length,
      member: people.filter((p) => p.role === 'member').length,
    }),
    [people],
  );

  function reset() {
    setEditingId(null);
    setDraft(EMPTY);
    setStep(1);
  }

  function startEdit(p) {
    setDone(null);
    setEditingId(p.id);
    setDraft({
      full_name: p.full_name ?? '',
      email: '',
      phone_e164: p.phone_e164 ?? '',
      title: p.title ?? '',
      password: '',
      role: p.role,
      parent_id: p.parent_id ?? '',
    });
    setStep(1);
    flowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function pickRole(role) {
    setDraft((d) => ({ ...d, role, parent_id: role === 'manager' ? '' : d.parent_id }));
    setStep(role === 'manager' ? 4 : 3);
  }

  function pickParent(parentId) {
    setDraft((d) => ({ ...d, parent_id: parentId }));
    setStep(4);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = {
        full_name: draft.full_name.trim(),
        title: draft.title.trim() || undefined,
        phone_e164: draft.phone_e164.trim(),
        role: draft.role,
        parent_id: draft.role === 'manager' ? null : draft.parent_id || existingManager?.id || null,
      };
      if (editingId) {
        const patch = { ...body };
        if (patch.role === editing.role) delete patch.role;
        if ((patch.parent_id ?? null) === (editing.parent_id ?? null)) delete patch.parent_id;
        await api(`/people/${editingId}`, session.token, { method: 'PATCH', body: JSON.stringify(patch) });
      } else {
        await api(`/orgs/${orgSlug}/people`, session.token, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            email: draft.email.trim(),
            password: draft.password || undefined,
          }),
        });
      }
      setDone({
        name: body.full_name,
        role: ROLE_LABEL[body.role],
        boss: body.parent_id ? byId[body.parent_id]?.full_name : null,
        edited: Boolean(editingId),
      });
      reset();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!window.confirm(`Remove ${editing.full_name} from this organisation?`)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/people/${editing.id}`, session.token, { method: 'DELETE' });
      setDone({ name: editing.full_name, removed: true });
      reset();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;

  if (!session?.token) {
    return (
      <div className="app app-in-shell">
        <div className="board">
          <main className="sheet">
            <div className="stage-head"><div><h1>People</h1></div></div>
            <p className="gs-empty"><a className="linkish" href="/">Sign in</a> to see your team.</p>
          </main>
        </div>
      </div>
    );
  }

  const detailsOk = draft.full_name.trim() && (editingId || draft.email.trim());
  const reportsToLabel = draft.parent_id ? byId[draft.parent_id]?.full_name : 'Their manager (default)';

  return (
    <div className="app app-in-shell">
      <div className="board">
    <main className="sheet">
      <div className="gs">
        <div className="stage-head">
          <div>
            <h1>People</h1>
            <p>{orgSlug ? `Everyone in ${orgName || orgSlug}` : 'Pick an organisation to see its people'}</p>
          </div>
        </div>

        {error ? <p className="err banner">{error}</p> : null}

        {/* ---------- Add / edit a person ---------- */}
        {canManage && orgSlug ? (
          <section className="gs-card" ref={flowRef} aria-label={editing ? 'Edit person' : 'Add a person'}>
            {done ? (
              <div className="gs-done" role="status">
                <span className="gs-done-icon" aria-hidden>✓</span>
                <div>
                  <b>{done.removed ? 'Removed' : done.edited ? 'Saved' : 'Added'}</b>
                  <p>
                    {done.removed
                      ? `${done.name} is no longer in this organisation.`
                      : `${done.name} · ${done.role}${done.boss ? ` · reports to ${done.boss}` : ''}`}
                  </p>
                </div>
                <button type="button" className="quiet" onClick={() => setDone(null)}>Add another person</button>
              </div>
            ) : (
              <>
                <div className="gs-list-head">
                  <h2>{editing ? `Edit ${editing.full_name}` : 'Add a person'}</h2>
                  {editing ? <button type="button" className="gs-change" onClick={reset}>Cancel</button> : null}
                </div>
                <ol className="gs-steps">
                  {/* Step 1: details */}
                  <li className={`gs-step${step === 1 ? ' is-active' : ' is-done'}`}>
                    <div className="gs-step-head">
                      <span className="gs-num">1</span>
                      <h2>Who are they?</h2>
                      {step > 1 ? (
                        <>
                          <span className="gs-picked">{draft.full_name}</span>
                          <button type="button" className="gs-change" onClick={() => setStep(1)}>Change</button>
                        </>
                      ) : null}
                    </div>
                    {step === 1 ? (
                      <form
                        className="gs-step-body"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (detailsOk) setStep(2);
                        }}
                      >
                        <div className="pp-fields">
                          <label>
                            <span>Full name</span>
                            <input value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} required autoFocus />
                          </label>
                          {editing ? null : (
                            <label>
                              <span>Email</span>
                              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
                            </label>
                          )}
                          <label>
                            <span>WhatsApp number <em>optional</em></span>
                            <input value={draft.phone_e164} onChange={(e) => setDraft({ ...draft, phone_e164: e.target.value })} placeholder="+91…" inputMode="tel" />
                          </label>
                          <label>
                            <span>Job title <em>optional</em></span>
                            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Associate" />
                          </label>
                          {editing ? null : (
                            <label>
                              <span>Password <em>optional · for web sign-in</em></span>
                              <input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} minLength={8} autoComplete="new-password" placeholder="At least 8 characters" />
                            </label>
                          )}
                        </div>
                        <button className="primary gs-save" type="submit" disabled={!detailsOk}>Next</button>
                      </form>
                    ) : null}
                  </li>

                  {/* Step 2: role */}
                  <li className={`gs-step${step === 2 ? ' is-active' : step > 2 ? ' is-done' : ''}`}>
                    <div className="gs-step-head">
                      <span className="gs-num">2</span>
                      <h2>What is their role?</h2>
                      {step > 2 ? (
                        <>
                          <span className="gs-picked">{ROLE_LABEL[draft.role]}</span>
                          <button type="button" className="gs-change" onClick={() => setStep(2)}>Change</button>
                        </>
                      ) : null}
                    </div>
                    {step === 2 ? (
                      <div className="gs-step-body">
                        <div className="gs-options">
                          {ROLES.filter((r) => allowedRoles.includes(r.value) || r.value === editing?.role).map((r) => {
                            const taken = r.value === 'manager' && existingManager && existingManager.id !== editingId;
                            return (
                              <button
                                key={r.value}
                                type="button"
                                className={`gs-option${draft.role === r.value ? ' is-on' : ''}`}
                                onClick={() => pickRole(r.value)}
                                disabled={taken || !allowedRoles.includes(r.value)}
                              >
                                <b>{r.label}</b>
                                <span>{taken ? `Already: ${existingManager.full_name}` : r.hint}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </li>

                  {/* Step 3: reports to */}
                  {draft.role !== 'manager' ? (
                    <li className={`gs-step${step === 3 ? ' is-active' : step > 3 ? ' is-done' : ''}`}>
                      <div className="gs-step-head">
                        <span className="gs-num">3</span>
                        <h2>Who do they report to?</h2>
                        {step > 3 ? (
                          <>
                            <span className="gs-picked">{reportsToLabel}</span>
                            <button type="button" className="gs-change" onClick={() => setStep(3)}>Change</button>
                          </>
                        ) : null}
                      </div>
                      {step === 3 ? (
                        <div className="gs-step-body">
                          <div className="gs-options">
                            <button type="button" className={`gs-option${!draft.parent_id ? ' is-on' : ''}`} onClick={() => pickParent('')}>
                              <b>Their manager</b>
                              <span>{existingManager ? existingManager.full_name : 'Default'}</span>
                            </button>
                            {leaders
                              .filter((p) => p.id !== existingManager?.id)
                              .map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  className={`gs-option${draft.parent_id === p.id ? ' is-on' : ''}`}
                                  onClick={() => pickParent(p.id)}
                                >
                                  <b>{p.full_name}</b>
                                  <span>{ROLE_LABEL[p.role]}</span>
                                </button>
                              ))}
                          </div>
                        </div>
                      ) : null}
                    </li>
                  ) : null}

                  {/* Save */}
                  {step === 4 ? (
                    <li className="gs-step is-active">
                      <div className="gs-step-body pp-confirm">
                        <p className="gs-hint">
                          <b>{draft.full_name}</b> · {ROLE_LABEL[draft.role]}
                          {draft.role !== 'manager' ? ` · reports to ${reportsToLabel}` : ''}
                        </p>
                        <div className="pp-confirm-actions">
                          <button className="primary" type="button" onClick={save} disabled={busy}>
                            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add person'}
                          </button>
                          {editing && editing.id !== membership?.id ? (
                            <button className="gs-change pp-remove" type="button" onClick={remove} disabled={busy}>
                              Remove from organisation
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ) : null}
                </ol>
              </>
            )}
          </section>
        ) : null}

        {/* ---------- Everyone ---------- */}
        <section className="gs-card" aria-label="Everyone">
          <div className="gs-list-head">
            <h2>Everyone</h2>
            <span className="gs-hint">{people.length} {people.length === 1 ? 'person' : 'people'}</span>
          </div>
          <div className="gs-filters">
            <div className="gs-seg" role="tablist" aria-label="Filter by role">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.value}
                  className={filter === f.value ? 'is-on' : ''}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label} {counts[f.value] ? <span className="pp-count">{counts[f.value]}</span> : null}
                </button>
              ))}
            </div>
            {people.length > 8 ? (
              <input className="pp-search" type="search" placeholder="Search name or title…" value={search} onChange={(e) => setSearch(e.target.value)} />
            ) : null}
          </div>

          {loading && !people.length ? <p className="gs-empty">Loading…</p> : null}
          {!loading && !orgSlug ? <p className="gs-empty">Pick an organisation from the menu.</p> : null}
          {!loading && orgSlug && !visible.length ? (
            <p className="gs-empty">{people.length ? 'Nobody matches this filter.' : 'Nobody here yet. Add the first person above.'}</p>
          ) : null}
          {visible.length ? (
            <ul className="gs-rows">
              {visible.map((p) => {
                const boss = p.parent_id ? byId[p.parent_id] : null;
                return (
                  <li key={p.id} className="gs-row pp-row">
                    <div className="gs-row-name">
                      <b>{p.full_name}</b>
                      <span>
                        {ROLE_LABEL[p.role] ?? p.role}
                        {p.title ? ` · ${p.title}` : ''}
                      </span>
                    </div>
                    <div className="gs-row-when">{boss ? `Reports to ${boss.full_name}` : ''}</div>
                    <div className="gs-row-when">
                      {p.state === 'pending_name' ? <span className="tag warn">Name pending</span> : p.phone_e164 || ''}
                    </div>
                    {canManage ? (
                      <button type="button" className="gs-change" onClick={() => startEdit(p)}>Edit</button>
                    ) : <span />}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        {/* ---------- Structure (tucked away) ---------- */}
        {canEditStructure ? (
          <details className="gs-card pp-details" open={searchParams.get('addOrg') === '1' || undefined}>
            <summary>
              <h2>Organisations &amp; teams</h2>
              <span className="gs-hint">Add an organisation, add teams, rename</span>
            </summary>
            <UnitStructure
              session={session}
              isOwner={isOwner}
              canEdit={canEditStructure}
              startWithAddOrg={searchParams.get('addOrg') === '1'}
            />
          </details>
        ) : null}
      </div>
    </main>
      </div>
    </div>
  );
}
