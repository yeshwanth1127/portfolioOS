'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';

const STATUS_LABEL = {
  planned: 'Planned',
  active: 'Active',
  on_hold: 'On hold',
  done: 'Done',
  cancelled: 'Cancelled',
};

function flattenUnits(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flattenUnits(n.children, out);
  }
  return out;
}

export default function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [session, setSession] = useState(null);
  const [token, setToken] = useState(null);
  const [projects, setProjects] = useState([]);
  const [units, setUnits] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savedViews, setSavedViews] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createUnitId, setCreateUnitId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const membership = session?.membership;
  const canCreate = Boolean(
    membership && ['owner', 'manager', 'vice_manager'].includes(membership.role),
  );

  const unitChoices = useMemo(() => {
    const flat = flattenUnits(units);
    if (membership?.role === 'owner') return flat;
    return flat.filter((u) => u.legacy_org_id === membership?.org_id);
  }, [units, membership?.role, membership?.org_id]);

  const load = useCallback(async (t, mem) => {
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      const requests = [api('/projects', t), api('/saved-views', t)];
      if (mem && ['owner', 'manager', 'vice_manager'].includes(mem.role)) {
        requests.push(api('/units/tree', t));
      }
      const results = await Promise.all(requests);
      setProjects(results[0].projects ?? []);
      setSavedViews(results[1].views ?? []);
      if (results[2]) {
        setUnits(results[2].tree ?? []);
      }
    } catch (e) {
      setError(e.message);
      setProjects([]);
      setSavedViews([]);
      setUnits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const s = readStoredSession();
    setSession(s);
    setToken(s?.token ?? null);
    load(s?.token ?? null, s?.membership);
  }, [load]);

  useEffect(() => {
    if (searchParams.get('new') === '1' && canCreate) {
      setShowCreate(true);
    }
  }, [searchParams, canCreate]);

  useEffect(() => {
    if (!createUnitId && unitChoices.length) {
      const preferred =
        unitChoices.find((u) => u.type === 'team')
        ?? unitChoices.find((u) => u.type === 'department')
        ?? unitChoices[0];
      setCreateUnitId(preferred?.id ?? '');
    }
  }, [unitChoices, createUnitId]);

  async function submitProject(e) {
    e.preventDefault();
    if (!token || !createName.trim() || !createUnitId) return;
    setCreateBusy(true);
    setError(null);
    try {
      const out = await api('/projects', token, {
        method: 'POST',
        body: JSON.stringify({ name: createName.trim(), unit_id: createUnitId }),
      });
      setShowCreate(false);
      setCreateName('');
      router.push(`/projects/${out.project.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase tracking-widest text-zinc-500">Delivery</p>
          <h1 className="m-0 text-2xl font-bold tracking-tight text-zinc-900">Projects</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {token && canCreate ? (
            <button type="button" className="primary text-sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? 'Cancel' : 'New project'}
            </button>
          ) : null}
          {token ? (
            <button type="button" className="quiet text-sm" onClick={() => load(token, membership)} disabled={loading}>
              Refresh
            </button>
          ) : null}
        </div>
      </header>

      {!token ? (
        <p className="text-sm text-zinc-600">Sign in from Overview to see projects.</p>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {loading && token ? <p className="text-sm text-zinc-500">Loading…</p> : null}

      {showCreate && canCreate ? (
        <form
          className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
          onSubmit={submitProject}
        >
          <h2 className="m-0 text-base font-semibold text-zinc-900">New project</h2>
          <p className="m-0 mt-1 text-sm text-zinc-600">
            Choose the unit that owns delivery. You can add tasks after the project is created.
          </p>
          {unitChoices.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950">
              <p className="m-0">No units yet — add an organisation on the People page first.</p>
              <Link href="/people?addOrg=1" className="primary mt-3 inline-block text-sm no-underline">
                Add organisation
              </Link>
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <label className="text-sm font-medium text-zinc-700">
                Name
                <input
                  className="mt-1 block w-full max-w-md rounded-lg border border-zinc-200 px-3 py-2"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Q4 rollout"
                  required
                />
              </label>
              <label className="text-sm font-medium text-zinc-700">
                Unit
                <select
                  className="mt-1 block w-full max-w-md rounded-lg border border-zinc-200 px-3 py-2"
                  value={createUnitId}
                  onChange={(e) => setCreateUnitId(e.target.value)}
                  required
                >
                  {unitChoices.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.type})
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <button type="submit" className="primary text-sm" disabled={createBusy}>
                  {createBusy ? 'Creating…' : 'Create project'}
                </button>
              </div>
            </div>
          )}
        </form>
      ) : null}

      {!loading && token && savedViews.length > 0 ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="m-0 text-sm font-bold uppercase tracking-widest text-zinc-500">Saved views</h2>
          <ul className="m-0 mt-2 list-none space-y-1 p-0">
            {savedViews.map((v) => (
              <li key={v.id} className="text-sm text-zinc-800">
                {v.name} <span className="text-zinc-500">→ {v.route}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!loading && token ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {projects.length === 0 ? (
            <li className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/90 p-5 text-sm text-zinc-600">
              <p className="m-0 font-semibold text-zinc-800">No projects yet</p>
              <p className="m-0 mt-1">
                {canCreate
                  ? 'Create a project, then add tasks for your team.'
                  : 'Your manager can create projects for your unit.'}
              </p>
              {canCreate ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className="primary text-sm" onClick={() => setShowCreate(true)}>
                    New project
                  </button>
                  {unitChoices.length === 0 ? (
                    <Link href="/people?addOrg=1" className="quiet text-sm no-underline">
                      Add organisation
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </li>
          ) : (
            projects.map((p) => (
              <li key={p.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="m-0 text-lg font-semibold text-zinc-900">
                    <Link href={`/projects/${p.id}`} className="text-inherit no-underline hover:underline">
                      {p.name}
                    </Link>
                  </h2>
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm text-zinc-600">
                  {p.unit_name ?? '—'} · {p.manager_name ?? '—'}
                  {p.open_tasks != null ? ` · ${p.open_tasks} open task${p.open_tasks === 1 ? '' : 's'}` : ''}
                </p>
                {p.due_on ? <p className="m-0 mt-1 text-xs text-zinc-500">Due {p.due_on}</p> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
