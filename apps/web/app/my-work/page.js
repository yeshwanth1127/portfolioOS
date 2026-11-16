'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';

const STATUS_LABEL = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
};

function dueTone(dueOn, today) {
  if (!dueOn) return 'none';
  if (dueOn < today) return 'overdue';
  if (dueOn === today) return 'today';
  if (dueOn === tomorrowFrom(today)) return 'tomorrow';
  return 'upcoming';
}

function tomorrowFrom(today) {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export default function MyWorkPage() {
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (t) => {
    if (!t) return;
    setLoading(true);
    setError(null);
    try {
      const out = await api('/my-work', t);
      setData(out);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const session = readStoredSession();
    setToken(session?.token ?? null);
    load(session?.token ?? null);
  }, [load]);

  const today = data?.today;

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const milestones = useMemo(() => data?.milestones ?? [], [data]);
  const approvals = useMemo(() => data?.approvals ?? [], [data]);

  async function completeTask(taskId) {
    if (!token) return;
    setBusyId(taskId);
    try {
      await api(`/tasks/${taskId}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
      await load(token);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase tracking-widest text-zinc-500">Delivery</p>
          <h1 className="m-0 text-2xl font-bold tracking-tight text-zinc-900">My Work</h1>
          {today ? <p className="m-0 mt-1 text-sm text-zinc-600">Today · {today}</p> : null}
        </div>
        {token ? (
          <button type="button" className="primary text-sm" onClick={() => load(token)} disabled={loading}>
            Refresh
          </button>
        ) : null}
      </header>

      {!token ? (
        <p className="text-sm text-zinc-600">Sign in from Overview to see your assignments.</p>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {loading && token ? <p className="text-sm text-zinc-500">Loading…</p> : null}

      {!loading && token ? (
        <>
          <section>
            <h2 className="m-0 mb-2 text-sm font-bold uppercase tracking-widest text-zinc-500">Your tasks</h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {tasks.length === 0 ? (
                <li className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/90 p-5 text-sm text-zinc-600">
                  <p className="m-0 font-semibold text-zinc-800">No open tasks assigned to you</p>
                  <p className="m-0 mt-1">
                    Tasks live on projects. Create a project and assign work, or ask your lead to assign you one.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link href="/projects?new=1" className="primary text-sm no-underline">
                      New project
                    </Link>
                    <Link href="/projects" className="quiet text-sm no-underline">
                      Browse projects
                    </Link>
                  </div>
                </li>
              ) : (
                tasks.map((t) => {
                  const tone = dueTone(t.due_on, today);
                  return (
                    <li
                      key={t.id}
                      className={`rounded-xl border bg-white p-4 shadow-sm${tone === 'overdue' ? ' border-red-200' : ' border-zinc-200'}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="m-0 text-lg font-semibold text-zinc-900">{t.title}</p>
                          <p className="m-0 mt-1 text-sm text-zinc-600">
                            <Link
                              href={`/projects/${t.project_id}`}
                              className="text-zinc-700 underline-offset-2 hover:underline"
                            >
                              {t.project_name}
                            </Link>
                            {t.due_on ? (
                              <span
                                className={
                                  tone === 'overdue'
                                    ? ' text-red-700'
                                    : tone === 'today'
                                      ? ' font-semibold text-amber-800'
                                      : ''
                                }
                              >
                                {' '}
                                · Due {t.due_on}
                                {tone === 'overdue' ? ' (overdue)' : tone === 'today' ? ' (today)' : ''}
                              </span>
                            ) : (
                              <span> · No due date</span>
                            )}
                          </p>
                          <p className="m-0 mt-1 text-xs uppercase tracking-wide text-zinc-500">
                            {STATUS_LABEL[t.status] ?? t.status}
                            {t.priority && t.priority !== 'normal' ? ` · ${t.priority} priority` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="primary shrink-0 text-sm"
                          disabled={busyId === t.id}
                          onClick={() => completeTask(t.id)}
                        >
                          {busyId === t.id ? 'Saving…' : 'Complete'}
                        </button>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </section>

          {milestones.length > 0 ? (
            <section>
              <h2 className="m-0 mb-2 text-sm font-bold uppercase tracking-widest text-zinc-500">Milestones you own</h2>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {milestones.map((m) => (
                  <li key={m.id} className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
                    <b className="text-base text-zinc-900">{m.name}</b>
                    <p className="m-0 mt-1 text-zinc-600">
                      {m.project_name} · due {m.due_on}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {approvals.length > 0 ? (
            <section>
              <h2 className="m-0 mb-2 text-sm font-bold uppercase tracking-widest text-zinc-500">Approvals waiting</h2>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {approvals.map((a) => (
                  <li key={a.id} className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
                    <b>{a.kpi_name}</b>
                    <p className="m-0 mt-1 text-zinc-600">
                      {a.org} · {a.period_date}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
