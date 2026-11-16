'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { readStoredSession } from '../../lib/session.js';

const STATUS_LABEL = {
  planned: 'Planned',
  active: 'Active',
  on_hold: 'On hold',
  done: 'Done',
  cancelled: 'Cancelled',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  open: 'Open',
};

const HEALTH_LABEL = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params?.id;
  const [token, setToken] = useState(null);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [tab, setTab] = useState('overview');

  const load = useCallback(async (t) => {
    if (!t || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api(`/projects/${projectId}`, t);
      setProject(data.project ?? null);
    } catch (e) {
      setError(e.message);
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const session = readStoredSession();
    setToken(session?.token ?? null);
    load(session?.token ?? null);
  }, [load]);

  async function addTask(e) {
    e.preventDefault();
    if (!token || !newTaskTitle.trim()) return;
    setTaskBusy(true);
    try {
      await api(`/projects/${projectId}/tasks`, token, {
        method: 'POST',
        body: JSON.stringify({ title: newTaskTitle.trim() }),
      });
      setNewTaskTitle('');
      await load(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setTaskBusy(false);
    }
  }

  async function completeTask(taskId) {
    if (!token) return;
    setTaskBusy(true);
    try {
      await api(`/tasks/${taskId}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
      setSelectedTask(null);
      await load(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setTaskBusy(false);
    }
  }

  const health = project?.health?.display;

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase tracking-widest text-zinc-500">
            <Link href="/projects" className="text-inherit no-underline hover:underline">
              Projects
            </Link>
            {projectId ? (
              <>
                {' · '}
                <Link href={`/projects/${projectId}/timeline`} className="text-inherit no-underline hover:underline">
                  Timeline
                </Link>
              </>
            ) : null}
          </p>
          <h1 className="m-0 text-2xl font-bold tracking-tight text-zinc-900">{project?.name ?? 'Project'}</h1>
          {project ? (
            <p className="m-0 mt-1 text-sm text-zinc-600">
              {project.unit_name} · {project.manager_name ?? '—'} · {STATUS_LABEL[project.status] ?? project.status}
              {health ? (
                <span className={health === 'at_risk' ? ' font-semibold text-amber-800' : ''}>
                  {' '}
                  · Health {HEALTH_LABEL[health] ?? health}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        {token ? (
          <button type="button" className="primary text-sm" onClick={() => load(token)} disabled={loading}>
            Refresh
          </button>
        ) : null}
      </header>

      {!token ? <p className="text-sm text-zinc-600">Sign in from Overview to view this project.</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {loading && token ? <p className="text-sm text-zinc-500">Loading…</p> : null}

      {!loading && project ? (
        <>
          <nav className="flex flex-wrap gap-2" aria-label="Project sections">
            {['overview', 'tasks', 'milestones'].map((key) => (
              <button
                key={key}
                type="button"
                className={tab === key ? 'primary text-sm' : 'text-sm text-zinc-700 underline-offset-2 hover:underline'}
                onClick={() => setTab(key)}
              >
                {key === 'overview' ? 'Overview' : key.charAt(0).toUpperCase() + key.slice(1)}
              </button>
            ))}
          </nav>

          {tab === 'overview' ? (
            <div className="flex flex-col gap-4">
              {project.description ? (
                <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <h2 className="m-0 text-sm font-bold uppercase tracking-widest text-zinc-500">About</h2>
                  <p className="m-0 mt-2 whitespace-pre-wrap text-sm text-zinc-800">{project.description}</p>
                </section>
              ) : null}
              {project.health ? (
                <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm text-sm text-zinc-700">
                  <h2 className="m-0 text-sm font-bold uppercase tracking-widest text-zinc-500">Health</h2>
                  <p className="m-0 mt-2">
                    Calculated: {HEALTH_LABEL[project.health.calculated] ?? project.health.calculated}
                    {project.health.override ? (
                      <>
                        {' '}
                        · Manager override: {HEALTH_LABEL[project.health.override] ?? project.health.override} —{' '}
                        {project.health.reason}
                      </>
                    ) : null}
                  </p>
                </section>
              ) : null}
              {(project.recent_updates ?? []).length > 0 ? (
                <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <h2 className="m-0 text-sm font-bold uppercase tracking-widest text-zinc-500">Recent updates</h2>
                  <ul className="m-0 mt-2 list-none p-0">
                    {project.recent_updates.map((u) => (
                      <li key={u.id} className="border-t border-zinc-100 py-2 text-sm first:border-0 first:pt-0">
                        <p className="m-0 text-zinc-800">{u.body}</p>
                        <p className="m-0 mt-1 text-xs text-zinc-500">
                          {u.author_name ?? '—'} · {u.created_at?.slice(0, 10)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}

          {tab === 'tasks' ? (
            <div className="flex flex-col gap-4 lg:flex-row">
              <div className="min-w-0 flex-1">
                <form className="mb-3 flex flex-wrap gap-2" onSubmit={addTask}>
                  <input
                    type="text"
                    className="min-w-[12rem] flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    placeholder="Quick-add task"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    disabled={taskBusy}
                  />
                  <button type="submit" className="primary text-sm" disabled={taskBusy || !newTaskTitle.trim()}>
                    Add
                  </button>
                </form>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {(project.tasks ?? []).length === 0 ? (
                    <li className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/90 p-4 text-sm text-zinc-600">
                      No tasks yet — use the field above to add the first one.
                    </li>
                  ) : null}
                  {(project.tasks ?? []).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={`w-full rounded-xl border bg-white p-4 text-left shadow-sm transition-colors${
                          selectedTask?.id === t.id ? ' border-zinc-400 ring-1 ring-zinc-300' : ' border-zinc-200 hover:border-zinc-300'
                        }`}
                        onClick={() => setSelectedTask(t)}
                      >
                        <span className="text-base font-semibold text-zinc-900">{t.title}</span>
                        <span className="mt-1 block text-xs uppercase tracking-wide text-zinc-500">
                          {STATUS_LABEL[t.status] ?? t.status}
                          {t.due_on ? ` · Due ${t.due_on}` : ''}
                          {t.assignee_name ? ` · ${t.assignee_name}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {selectedTask ? (
                <aside className="w-full shrink-0 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm lg:w-80">
                  <h2 className="m-0 text-lg font-semibold text-zinc-900">{selectedTask.title}</h2>
                  {selectedTask.description ? (
                    <p className="m-0 mt-2 text-sm text-zinc-700">{selectedTask.description}</p>
                  ) : (
                    <p className="m-0 mt-2 text-sm text-zinc-500">No description.</p>
                  )}
                  <p className="m-0 mt-2 text-xs text-zinc-500">
                    {STATUS_LABEL[selectedTask.status] ?? selectedTask.status}
                    {selectedTask.priority && selectedTask.priority !== 'normal' ? ` · ${selectedTask.priority}` : ''}
                  </p>
                  {selectedTask.status !== 'done' ? (
                    <button
                      type="button"
                      className="primary mt-4 text-sm"
                      disabled={taskBusy}
                      onClick={() => completeTask(selectedTask.id)}
                    >
                      Mark complete
                    </button>
                  ) : null}
                </aside>
              ) : null}
            </div>
          ) : null}

          {tab === 'milestones' ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {(project.milestones ?? []).length === 0 ? (
                <li className="rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">No milestones yet.</li>
              ) : (
                project.milestones.map((m) => (
                  <li key={m.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <b className="text-base text-zinc-900">{m.name}</b>
                    <p className="m-0 mt-1 text-sm text-zinc-600">
                      {STATUS_LABEL[m.status] ?? m.status}
                      {m.due_on ? ` · due ${m.due_on}` : ''}
                      {m.owner_name ? ` · ${m.owner_name}` : ''}
                    </p>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
