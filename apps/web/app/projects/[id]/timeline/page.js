'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api.js';
import { readStoredSession } from '../../../lib/session.js';

function weekStart(d) {
  const dt = new Date(`${d}T12:00:00`);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return dt.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const dt = new Date(`${iso}T12:00:00`);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}

export default function ProjectTimelinePage() {
  const params = useParams();
  const projectId = params?.id;
  const [token, setToken] = useState(null);
  const [project, setProject] = useState(null);
  const [anchor, setAnchor] = useState(() => weekStart(new Date().toISOString().slice(0, 10)));
  const [error, setError] = useState(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);

  const load = useCallback(async (t) => {
    if (!t || !projectId) return;
    setError(null);
    try {
      const data = await api(`/projects/${projectId}`, t);
      setProject(data.project ?? null);
    } catch (e) {
      setError(e.message);
      setProject(null);
    }
  }, [projectId]);

  useEffect(() => {
    const session = readStoredSession();
    setToken(session?.token ?? null);
    load(session?.token ?? null);
  }, [load]);

  const items = [
    ...(project?.tasks ?? []).map((t) => ({ kind: 'task', id: t.id, label: t.title, due: t.due_on, status: t.status })),
    ...(project?.milestones ?? []).map((m) => ({ kind: 'milestone', id: m.id, label: m.name, due: m.due_on, status: m.status })),
  ].filter((i) => i.due);

  return (
    <div className="overview-page flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
      <header>
        <p className="m-0 text-xs font-bold uppercase tracking-widest text-zinc-500">
          <Link href={`/projects/${projectId}`} className="text-inherit no-underline hover:underline">
            {project?.name ?? 'Project'}
          </Link>
          {' · Timeline'}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="text-sm underline" onClick={() => setAnchor(addDays(anchor, -7))}>
            ← Prev week
          </button>
          <button type="button" className="text-sm underline" onClick={() => setAnchor(weekStart(new Date().toISOString().slice(0, 10)))}>
            This week
          </button>
          <button type="button" className="text-sm underline" onClick={() => setAnchor(addDays(anchor, 7))}>
            Next week →
          </button>
        </div>
      </header>

      {!token ? <p className="text-sm text-zinc-600">Sign in to view the timeline.</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div
        className="grid gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm"
        style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}
      >
        {days.map((d) => (
          <div key={d} className="min-h-[6rem] border-r border-zinc-100 p-2 last:border-0">
            <p className="m-0 text-xs font-semibold text-zinc-500">{d.slice(5)}</p>
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {items
                .filter((i) => i.due === d)
                .map((i) => (
                  <li
                    key={`${i.kind}-${i.id}`}
                    className={`rounded-md px-2 py-1 text-xs ${
                      i.kind === 'milestone' ? 'bg-rose-100 text-rose-900' : 'bg-zinc-100 text-zinc-800'
                    }`}
                  >
                    {i.label}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
