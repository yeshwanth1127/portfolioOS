'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { ORG_CHANGE_EVENT, ORGS_UPDATED_EVENT, writeStoredOrgSlug } from '../lib/session.js';

/** Organisation structure: unit tree, add organisation, add child unit, rename. Owner / org manager. */

const UNIT_TYPE_LABELS = {
  organisation: 'Organisation',
  branch: 'Branch',
  department: 'Department',
  team: 'Team',
};

function childTypesForParent(parentType) {
  switch (parentType) {
    case 'organisation':
      return ['branch', 'department', 'team'];
    case 'branch':
      return ['department', 'team'];
    case 'department':
      return ['team'];
    default:
      return [];
  }
}

function flattenUnits(nodes, depth = 0, out = []) {
  for (const n of nodes ?? []) {
    out.push({ ...n, depth });
    flattenUnits(n.children, depth + 1, out);
  }
  return out;
}

export default function UnitStructure({ session, isOwner, canEdit, startWithAddOrg = false }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [modal, setModal] = useState(startWithAddOrg && isOwner ? 'org' : null);
  const [form, setForm] = useState({ name: '', short_name: '', slug: '', type: 'team' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [modalError, setModalError] = useState('');

  useEffect(() => {
    if (startWithAddOrg && isOwner) setModal('org');
  }, [startWithAddOrg, isOwner]);

  const load = useCallback(async () => {
    if (!session?.token) return;
    setLoading(true);
    try {
      const data = await api('/units/tree', session.token);
      setTree(data.tree ?? []);
    } catch (err) {
      setNotice(err.message);
      setTree([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  const units = useMemo(() => flattenUnits(tree), [tree]);
  const selected = units.find((u) => u.id === selectedId) ?? null;
  const childTypes = selected ? childTypesForParent(selected.type) : [];

  function open(kind) {
    setModalError('');
    setNotice('');
    if (kind === 'org') setForm({ name: '', short_name: '', slug: '', type: 'team' });
    if (kind === 'create') setForm({ name: '', short_name: '', slug: '', type: childTypes[0] ?? 'team' });
    if (kind === 'rename') setForm({ name: selected?.name ?? '', short_name: selected?.short_name ?? '', slug: '', type: '' });
    setModal(kind);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setModalError('');
    try {
      if (modal === 'org') {
        const body = { name: form.name.trim(), short_name: form.short_name.trim() || form.name.trim() };
        if (form.slug.trim()) body.slug = form.slug.trim();
        const data = await api('/orgs', session.token, { method: 'POST', body: JSON.stringify(body) });
        if (data.org?.slug) {
          writeStoredOrgSlug(data.org.slug);
          window.dispatchEvent(new CustomEvent(ORG_CHANGE_EVENT, { detail: { slug: data.org.slug } }));
        }
        window.dispatchEvent(new CustomEvent(ORGS_UPDATED_EVENT));
        setNotice(`Created organisation “${data.org?.short_name ?? data.org?.name}”.`);
      } else if (modal === 'create') {
        const data = await api('/units', session.token, {
          method: 'POST',
          body: JSON.stringify({
            parent_id: selectedId,
            type: form.type,
            name: form.name.trim(),
            short_name: form.short_name.trim() || undefined,
          }),
        });
        setNotice(`Created ${UNIT_TYPE_LABELS[form.type]?.toLowerCase() ?? 'unit'} “${data.unit?.name ?? form.name.trim()}”.`);
        if (data.unit?.id) setSelectedId(data.unit.id);
      } else if (modal === 'rename') {
        await api(`/units/${selectedId}`, session.token, {
          method: 'PATCH',
          body: JSON.stringify({ name: form.name.trim(), short_name: form.short_name.trim() || null }),
        });
        setNotice('Renamed.');
      }
      setModal(null);
      await load();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const title = modal === 'org' ? 'Add organisation' : modal === 'create' ? `Add under ${selected?.name ?? ''}` : 'Rename';

  return (
    <div className="pp-structure">
      <div className="pp-structure-actions">
        {isOwner ? (
          <button type="button" className="quiet" onClick={() => open('org')}>+ Add organisation</button>
        ) : null}
        {canEdit && selected && childTypes.length ? (
          <button type="button" className="quiet" onClick={() => open('create')}>+ Add team under {selected.name}</button>
        ) : null}
        {canEdit && selected ? (
          <button type="button" className="quiet" onClick={() => open('rename')}>Rename {selected.name}</button>
        ) : null}
      </div>
      {notice ? <p className="gs-hint">{notice}</p> : null}
      {loading && !units.length ? <p className="gs-empty">Loading…</p> : null}
      {!loading && !units.length ? <p className="gs-empty">No organisations yet.</p> : null}
      {units.length ? (
        <>
          {canEdit ? <p className="gs-hint">Click a unit to add a team under it or rename it.</p> : null}
          <ul className="pp-units">
            {units.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={`pp-unit${selectedId === u.id ? ' is-on' : ''}`}
                  style={{ paddingLeft: `${12 + u.depth * 20}px` }}
                  onClick={() => setSelectedId(selectedId === u.id ? null : u.id)}
                  disabled={!canEdit}
                >
                  <b>{u.name}</b>
                  <span>{UNIT_TYPE_LABELS[u.type] ?? u.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {modal ? (
        <div className="calendar-modal-backdrop" role="presentation" onClick={() => !busy && setModal(null)}>
          <form className="calendar-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h3>{title}</h3>
            {modalError ? <p className="err">{modalError}</p> : null}
            {modal === 'create' && childTypes.length > 1 ? (
              <label>
                Type
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {childTypes.map((t) => (
                    <option key={t} value={t}>{UNIT_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus autoComplete="off" />
            </label>
            <label>
              Short name
              <input
                value={form.short_name}
                onChange={(e) => setForm({ ...form, short_name: e.target.value })}
                placeholder="Optional — shown in menus"
                autoComplete="off"
              />
            </label>
            <div className="calendar-modal-actions">
              <button type="button" className="quiet" disabled={busy} onClick={() => setModal(null)}>Cancel</button>
              <button className="primary" type="submit" disabled={busy || !form.name.trim()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
