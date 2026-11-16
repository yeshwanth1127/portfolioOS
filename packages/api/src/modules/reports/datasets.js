/*
 * Report datasets: every figure a report shows is computed here, from live tables, inside the
 * requester's scoped transaction (row-level security applies). The agent never produces numbers.
 *
 * A dataset is { title, columns: [{ key, label, format }], rows: [...], totals: {...}, note? }.
 * Formats: text · int · num · pct (0..1) · date · time · hours · status (good/watch/bad/unscored).
 */
import { addDays } from '../../core/dates.js';
import { periodWindow } from '../../cadence.js';

const DONE_STATES = ['submitted', 'validated', 'locked', 'amended'];
const CADENCE_WORD = { 'Every day': 'Daily', 'Every week': 'Weekly', 'Every month': 'Monthly', 'Every quarter': 'Quarterly' };
const RAG_WORD = { green: 'good', amber: 'watch', red: 'bad', unscored: 'unscored' };

const col = (key, label, format = 'text') => ({ key, label, format });
const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 1000 : null);
const round1 = (n) => Math.round(n * 10) / 10;

function dataset(title, columns, rows, totals = {}, note = null) {
  return { title, columns, rows, totals, ...(note ? { note } : {}) };
}

/** Every date from..to inclusive. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function isoWeekKey(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

function bucketKey(howOften, iso) {
  switch (howOften) {
    case 'Every week':
      return isoWeekKey(iso);
    case 'Every month':
      return iso.slice(0, 7);
    case 'Every quarter':
      return `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
    default:
      return iso;
  }
}

/**
 * Reporting periods of `cadence` that are due within the range: a day is due on the day, a
 * week / month / quarter once its last day is on or before `to` (a period still running is
 * not yet missing).
 */
function expectedBuckets(cadence, days, to) {
  const out = new Set();
  for (const d of days) {
    if (cadence === 'Every day' || periodWindow(cadence, d).end <= to) out.add(bucketKey(cadence, d));
  }
  return out;
}

/** Memoise a builder on the context so combined reports compute each source once. */
function memo(ctx, key, fn) {
  ctx.cache ??= new Map();
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key);
}

/** Names, roles and organisations of everyone in scope. */
export function peopleInfo(ctx) {
  return memo(ctx, 'people', async () => {
    const { rows } = await ctx.client.query(
      `SELECT m.id, u.full_name AS name, m.role::text AS role, m.title, o.short_name AS org
       FROM memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN organisations o ON o.id = m.org_id
       WHERE m.id = ANY($1::uuid[])
       ORDER BY o.short_name NULLS FIRST, u.full_name`,
      [ctx.scope.people],
    );
    return rows;
  });
}

function scopeIsWide(ctx) {
  return ctx.scope.kind === 'workspace';
}

// KPIs --------------------------------------------------------------------------------------------

async function kpiSource(ctx) {
  return memo(ctx, 'kpi', async () => {
    const params = [];
    let where = `k.status = 'active'`;
    if (ctx.scope.kind === 'org') {
      params.push(ctx.scope.orgId);
      where += ` AND k.org_id = $1`;
    } else if (!scopeIsWide(ctx)) {
      params.push(ctx.scope.people);
      where += ` AND k.owner_id = ANY($1::uuid[])`;
    }
    const { rows: kpis } = await ctx.client.query(
      `SELECT k.id, k.name, k.unit, k.owner_id,
              coalesce(bg.how_often, k.how_often)::text AS how_often,
              coalesce(bg.target, k.target) AS target,
              o.id AS org_id, o.short_name AS org, u.full_name AS owner
       FROM kpis k
       JOIN organisations o ON o.id = k.org_id
       LEFT JOIN LATERAL (
         SELECT g.how_often, g.target FROM kpi_goals g WHERE g.kpi_id = k.id
         ORDER BY array_position(ARRAY['Every day','Every week','Every month','Every quarter']::how_often[], g.how_often)
         LIMIT 1
       ) bg ON TRUE
       LEFT JOIN memberships m ON m.id = k.owner_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE ${where}
       ORDER BY o.short_name, k.name`,
      params,
    );
    const ids = kpis.map((k) => k.id);
    const { rows: scores } = ids.length
      ? await ctx.client.query(
          `SELECT kpi_id, period_date, value, rag::text AS rag, how_often::text AS how_often
           FROM scores WHERE kpi_id = ANY($1::uuid[]) AND period_date BETWEEN $2::date AND $3::date
           ORDER BY period_date`,
          [ids, ctx.from, ctx.to],
        )
      : { rows: [] };
    // One score per KPI-day: the row for the cadence its numbers are entered at (its base cadence).
    const base = new Map(kpis.map((k) => [k.id, k.how_often]));
    const baseScores = scores.filter((s) => (s.how_often ?? base.get(s.kpi_id)) === base.get(s.kpi_id));
    const { rows: subs } = ids.length
      ? await ctx.client.query(
          `SELECT kpi_id, period_date, state::text AS state, submitted_by
           FROM submissions WHERE kpi_id = ANY($1::uuid[]) AND period_date BETWEEN $2::date AND $3::date`,
          [ids, ctx.from, ctx.to],
        )
      : { rows: [] };
    return { kpis, scores: baseScores, subs };
  });
}

export async function kpiDatasets(ctx) {
  const { kpis, scores } = await kpiSource(ctx);
  const byKpi = new Map(kpis.map((k) => [k.id, { ...k, good: 0, watch: 0, bad: 0, unscored: 0, latest: null }]));
  const trend = new Map(daysBetween(ctx.from, ctx.to).map((d) => [d, { date: d, good: 0, watch: 0, bad: 0 }]));
  for (const s of scores) {
    const k = byKpi.get(s.kpi_id);
    if (!k) continue;
    const word = RAG_WORD[s.rag] ?? 'unscored';
    k[word] += 1;
    k.latest = s;
    const day = trend.get(s.period_date);
    if (day && word !== 'unscored') day[word] += 1;
  }

  const rows = [...byKpi.values()].map((k) => {
    const scored = k.good + k.watch + k.bad;
    return {
      org: k.org,
      kpi: k.name,
      owner: k.owner ?? 'Unassigned',
      how_often: CADENCE_WORD[k.how_often] ?? k.how_often,
      target: k.target == null ? null : Number(k.target),
      unit: k.unit,
      good: k.good,
      watch: k.watch,
      bad: k.bad,
      attainment: rate(k.good, scored),
      latest_value: k.latest?.value == null ? null : Number(k.latest.value),
      latest_status: k.latest ? RAG_WORD[k.latest.rag] ?? 'unscored' : 'unscored',
    };
  });
  rows.sort((a, b) => (a.attainment ?? 2) - (b.attainment ?? 2) || a.kpi.localeCompare(b.kpi));

  const orgs = new Map();
  for (const r of rows) {
    const o = orgs.get(r.org) ?? { org: r.org, kpis: 0, good: 0, watch: 0, bad: 0 };
    o.kpis += 1;
    o.good += r.good;
    o.watch += r.watch;
    o.bad += r.bad;
    orgs.set(r.org, o);
  }
  const orgRows = [...orgs.values()].map((o) => ({ ...o, attainment: rate(o.good, o.good + o.watch + o.bad) }));

  const good = rows.reduce((s, r) => s + r.good, 0);
  const watch = rows.reduce((s, r) => s + r.watch, 0);
  const bad = rows.reduce((s, r) => s + r.bad, 0);
  const totals = {
    kpis: rows.length,
    scored_points: good + watch + bad,
    good,
    watch,
    bad,
    attainment: rate(good, good + watch + bad),
    off_track_now: rows.filter((r) => r.latest_status === 'bad').length,
    kpis_never_scored: rows.filter((r) => r.good + r.watch + r.bad === 0).length,
  };

  return {
    kpi_by_kpi: dataset(
      'Target attainment by KPI',
      [
        col('org', 'Organisation'),
        col('kpi', 'KPI'),
        col('owner', 'Owner'),
        col('target', 'Goal', 'num'),
        col('how_often', 'Cadence'),
        col('good', 'Good', 'int'),
        col('watch', 'Watch', 'int'),
        col('bad', 'Bad', 'int'),
        col('attainment', 'Attainment', 'pct'),
        col('latest_value', 'Latest value', 'num'),
        col('latest_status', 'Latest status', 'status'),
      ],
      rows,
      totals,
      'Attainment = scored periods rated good ÷ all scored periods in the range.',
    ),
    kpi_trend: dataset(
      'Scored KPIs per day',
      [col('date', 'Date', 'date'), col('good', 'Good', 'int'), col('watch', 'Watch', 'int'), col('bad', 'Bad', 'int')],
      [...trend.values()],
      totals,
    ),
    kpi_by_org: dataset(
      'Attainment by organisation',
      [
        col('org', 'Organisation'),
        col('kpis', 'KPIs', 'int'),
        col('good', 'Good', 'int'),
        col('watch', 'Watch', 'int'),
        col('bad', 'Bad', 'int'),
        col('attainment', 'Attainment', 'pct'),
      ],
      orgRows,
      totals,
    ),
  };
}

// Reporting completeness -----------------------------------------------------------------------

export async function reportingDatasets(ctx) {
  const { kpis, subs } = await kpiSource(ctx);
  const days = daysBetween(ctx.from, ctx.to);
  const subsByKpi = new Map();
  for (const s of subs) {
    if (!subsByKpi.has(s.kpi_id)) subsByKpi.set(s.kpi_id, []);
    subsByKpi.get(s.kpi_id).push(s);
  }

  const perKpi = kpis.map((k) => {
    const expected = expectedBuckets(k.how_often, days, ctx.to);
    const got = new Set();
    let pending = 0;
    let rejected = 0;
    for (const s of subsByKpi.get(k.id) ?? []) {
      if (DONE_STATES.includes(s.state)) got.add(bucketKey(k.how_often, s.period_date));
      if (s.state === 'submitted') pending += 1;
      if (s.state === 'rejected') rejected += 1;
    }
    const received = [...got].filter((b) => expected.has(b)).length;
    return { k, expected: expected.size, received, pending, rejected };
  });

  const group = (keyFn, labelKey) => {
    const map = new Map();
    for (const r of perKpi) {
      const key = keyFn(r.k);
      const g = map.get(key) ?? { [labelKey]: key, kpis: 0, expected: 0, received: 0, pending: 0, rejected: 0 };
      g.kpis += 1;
      g.expected += r.expected;
      g.received += r.received;
      g.pending += r.pending;
      g.rejected += r.rejected;
      map.set(key, g);
    }
    return [...map.values()]
      .map((g) => ({ ...g, missing: g.expected - g.received, rate: rate(g.received, g.expected) }))
      .sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2));
  };

  const daily = kpis.filter((k) => k.how_often === 'Every day');
  const dailyIds = new Set(daily.map((k) => k.id));
  const trend = days.map((d) => {
    const got = new Set(
      subs.filter((s) => dailyIds.has(s.kpi_id) && s.period_date === d && DONE_STATES.includes(s.state)).map((s) => s.kpi_id),
    );
    return { date: d, expected: daily.length, received: got.size, missing: daily.length - got.size };
  });

  const expected = perKpi.reduce((s, r) => s + r.expected, 0);
  const received = perKpi.reduce((s, r) => s + r.received, 0);
  const totals = {
    kpis: kpis.length,
    expected,
    received,
    missing: expected - received,
    rate: rate(received, expected),
    pending_approval: perKpi.reduce((s, r) => s + r.pending, 0),
    rejected: perKpi.reduce((s, r) => s + r.rejected, 0),
  };
  const cols = (first, label) => [
    col(first, label),
    col('kpis', 'KPIs', 'int'),
    col('expected', 'Expected', 'int'),
    col('received', 'Received', 'int'),
    col('missing', 'Missing', 'int'),
    col('rate', 'Completeness', 'pct'),
    col('pending', 'Awaiting approval', 'int'),
  ];
  return {
    reporting_by_person: dataset(
      'Reporting by KPI owner',
      cols('owner', 'Owner'),
      group((k) => k.owner ?? 'Unassigned', 'owner'),
      totals,
      'Expected = reporting periods in the range for each KPI (daily, weekly, monthly or quarterly).',
    ),
    reporting_by_org: dataset('Reporting by organisation', cols('org', 'Organisation'), group((k) => k.org, 'org'), totals),
    reporting_trend: dataset(
      'Daily KPI numbers received',
      [col('date', 'Date', 'date'), col('received', 'Received', 'int'), col('missing', 'Missing', 'int')],
      trend,
      totals,
    ),
  };
}

// Tasks -------------------------------------------------------------------------------------------

async function taskSource(ctx) {
  return memo(ctx, 'tasks', async () => {
    const params = [ctx.from, ctx.to, ctx.tz];
    let who = '';
    if (!scopeIsWide(ctx)) {
      params.push(ctx.scope.people);
      who = ` AND t.assignee_id = ANY($4::uuid[])`;
    }
    const { rows } = await ctx.client.query(
      `SELECT t.id, t.title, t.status, t.priority, t.due_on, t.assignee_id,
              (t.completed_at AT TIME ZONE $3)::date AS done_on,
              (t.created_at AT TIME ZONE $3)::date AS created_on,
              p.id AS project_id, p.name AS project, u.full_name AS assignee
       FROM tasks t
       JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
       LEFT JOIN memberships m ON m.id = t.assignee_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE t.status <> 'cancelled'
         AND (
           ((t.completed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date)
           OR t.due_on BETWEEN $1::date AND $2::date
           OR (t.status <> 'done' AND (t.created_at AT TIME ZONE $3)::date <= $2::date)
         )${who}`,
      params,
    );
    return rows;
  });
}

function taskFacts(ctx, t) {
  const doneInRange = t.status === 'done' && t.done_on && t.done_on >= ctx.from && t.done_on <= ctx.to;
  const asOf = ctx.to < ctx.today ? ctx.to : ctx.today;
  const open = t.status !== 'done';
  return {
    done: doneInRange,
    on_time: doneInRange && t.due_on != null && t.done_on <= t.due_on,
    late: doneInRange && t.due_on != null && t.done_on > t.due_on,
    open,
    overdue: open && t.due_on != null && t.due_on < asOf,
    created: t.created_on >= ctx.from && t.created_on <= ctx.to,
  };
}

export async function taskDatasets(ctx) {
  const tasks = await taskSource(ctx);
  const people = await peopleInfo(ctx);
  const perPerson = new Map(
    people.map((p) => [p.id, { person: p.name, org: p.org ?? '', assigned: 0, completed: 0, on_time: 0, late: 0, open: 0, overdue: 0 }]),
  );
  const trend = new Map(daysBetween(ctx.from, ctx.to).map((d) => [d, { date: d, completed: 0 }]));
  const completedList = [];
  const overdueList = [];
  const totals = { tasks: 0, assigned_in_period: 0, completed: 0, on_time: 0, late: 0, open: 0, overdue: 0, unassigned_open: 0 };

  for (const t of tasks) {
    const f = taskFacts(ctx, t);
    totals.tasks += 1;
    if (f.created) totals.assigned_in_period += 1;
    if (f.done) totals.completed += 1;
    if (f.on_time) totals.on_time += 1;
    if (f.late) totals.late += 1;
    if (f.open) totals.open += 1;
    if (f.overdue) totals.overdue += 1;
    if (f.open && !t.assignee_id) totals.unassigned_open += 1;
    const p = t.assignee_id ? perPerson.get(t.assignee_id) : null;
    if (p) {
      if (f.created) p.assigned += 1;
      if (f.done) p.completed += 1;
      if (f.on_time) p.on_time += 1;
      if (f.late) p.late += 1;
      if (f.open) p.open += 1;
      if (f.overdue) p.overdue += 1;
    }
    if (f.done) {
      const day = trend.get(t.done_on);
      if (day) day.completed += 1;
      completedList.push({ date: t.done_on, task: t.title, project: t.project, person: t.assignee ?? 'Unassigned', due: t.due_on });
    }
    if (f.overdue) {
      overdueList.push({ task: t.title, project: t.project, person: t.assignee ?? 'Unassigned', due: t.due_on, priority: t.priority });
    }
  }
  totals.on_time_rate = rate(totals.on_time, totals.on_time + totals.late);
  completedList.sort((a, b) => a.date.localeCompare(b.date));
  overdueList.sort((a, b) => a.due.localeCompare(b.due));
  const personRows = [...perPerson.values()].map((p) => ({ ...p, on_time_rate: rate(p.on_time, p.on_time + p.late) }));
  personRows.sort((a, b) => b.completed - a.completed || b.overdue - a.overdue || a.person.localeCompare(b.person));

  return {
    tasks_by_person: dataset(
      'Task delivery by person',
      [
        col('person', 'Person'),
        col('org', 'Organisation'),
        col('assigned', 'New tasks', 'int'),
        col('completed', 'Completed', 'int'),
        col('on_time_rate', 'On time', 'pct'),
        col('open', 'Open now', 'int'),
        col('overdue', 'Overdue', 'int'),
      ],
      personRows,
      totals,
      'On time = completed on or before the due date (tasks with a due date only).',
    ),
    tasks_trend: dataset('Tasks completed per day', [col('date', 'Date', 'date'), col('completed', 'Completed', 'int')], [...trend.values()], totals),
    tasks_completed: dataset(
      'Tasks completed',
      [col('date', 'Completed', 'date'), col('task', 'Task'), col('project', 'Project'), col('person', 'Person'), col('due', 'Due', 'date')],
      completedList,
      totals,
    ),
    tasks_overdue: dataset(
      'Overdue tasks',
      [col('due', 'Due', 'date'), col('task', 'Task'), col('project', 'Project'), col('person', 'Person'), col('priority', 'Priority')],
      overdueList,
      totals,
    ),
  };
}

// Projects and milestones --------------------------------------------------------------------------

export async function projectDatasets(ctx) {
  const params = [ctx.from, ctx.to, ctx.tz, ctx.today];
  let filter = '';
  if (ctx.scope.kind === 'org') {
    params.push(ctx.scope.orgId);
    filter = ` AND un.legacy_org_id = $5`;
  } else if (!scopeIsWide(ctx)) {
    params.push(ctx.scope.people);
    filter = ` AND (p.manager_id = ANY($5::uuid[]) OR EXISTS (
      SELECT 1 FROM tasks tt WHERE tt.project_id = p.id AND tt.assignee_id = ANY($5::uuid[])))`;
  }
  const { rows } = await ctx.client.query(
    `SELECT p.id, p.name AS project, p.status, p.due_on, un.short_name AS unit_short, un.name AS unit,
            count(t.id) FILTER (WHERE t.status <> 'cancelled')::int AS tasks,
            count(t.id) FILTER (WHERE t.status = 'done')::int AS done,
            count(t.id) FILTER (WHERE t.status NOT IN ('done','cancelled'))::int AS open,
            count(t.id) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_on < LEAST($2::date, $4::date))::int AS overdue,
            count(t.id) FILTER (WHERE t.status = 'done'
              AND (t.completed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date)::int AS done_in_period,
            (SELECT count(*)::int FROM project_updates pu WHERE pu.project_id = p.id
               AND (pu.created_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date) AS updates
     FROM projects p
     JOIN units un ON un.id = p.unit_id AND un.workspace_id = p.workspace_id
     LEFT JOIN tasks t ON t.project_id = p.id AND t.workspace_id = p.workspace_id
     WHERE p.status <> 'cancelled'${filter}
     GROUP BY p.id, un.short_name, un.name
     ORDER BY p.name`,
    params,
  );
  const projectRows = rows.map((r) => ({
    project: r.project,
    unit: r.unit_short || r.unit,
    status: r.status.replace('_', ' '),
    tasks: r.tasks,
    done: r.done,
    open: r.open,
    overdue: r.overdue,
    progress: rate(r.done, r.tasks),
    done_in_period: r.done_in_period,
    updates: r.updates,
    due: r.due_on,
  }));
  const ids = rows.map((r) => r.id);
  const { rows: ms } = ids.length
    ? await ctx.client.query(
        `SELECT m.name, m.status, m.due_on, (m.completed_at AT TIME ZONE $3)::date AS done_on, p.name AS project
         FROM milestones m JOIN projects p ON p.id = m.project_id AND p.workspace_id = m.workspace_id
         WHERE m.project_id = ANY($4::uuid[]) AND m.status <> 'cancelled'
           AND m.due_on BETWEEN $1::date AND $2::date
         ORDER BY m.due_on`,
        [ctx.from, ctx.to, ctx.tz, ids],
      )
    : { rows: [] };
  const asOf = ctx.to < ctx.today ? ctx.to : ctx.today;
  const milestoneRows = ms.map((m) => ({
    due: m.due_on,
    milestone: m.name,
    project: m.project,
    result:
      m.status === 'done'
        ? m.done_on && m.done_on <= m.due_on
          ? 'on time'
          : 'late'
        : m.due_on < asOf
          ? 'overdue'
          : 'open',
  }));
  const count = (word) => milestoneRows.filter((m) => m.result === word).length;
  const totals = {
    projects: projectRows.length,
    active_projects: rows.filter((r) => r.status === 'active').length,
    tasks_done_in_period: projectRows.reduce((s, r) => s + r.done_in_period, 0),
    overdue_tasks: projectRows.reduce((s, r) => s + r.overdue, 0),
    updates_posted: projectRows.reduce((s, r) => s + r.updates, 0),
    milestones_due: milestoneRows.length,
    milestones_on_time: count('on time'),
    milestones_late: count('late'),
    milestones_overdue: count('overdue'),
  };
  return {
    projects_progress: dataset(
      'Project progress',
      [
        col('project', 'Project'),
        col('unit', 'Unit'),
        col('status', 'Status'),
        col('progress', 'Progress', 'pct'),
        col('done_in_period', 'Done in period', 'int'),
        col('open', 'Open', 'int'),
        col('overdue', 'Overdue', 'int'),
        col('updates', 'Updates', 'int'),
      ],
      projectRows,
      totals,
      'Progress = done tasks ÷ all tasks (cancelled excluded), as of now.',
    ),
    milestones: dataset(
      'Milestones due in the period',
      [col('due', 'Due', 'date'), col('milestone', 'Milestone'), col('project', 'Project'), col('result', 'Result')],
      milestoneRows,
      totals,
    ),
  };
}

// Workload (snapshot as of today) ---------------------------------------------------------------

export async function workloadDatasets(ctx) {
  const people = await peopleInfo(ctx);
  const week = addDays(ctx.today, 7);
  const { rows } = await ctx.client.query(
    `SELECT t.assignee_id,
            count(*)::int AS open,
            count(*) FILTER (WHERE t.due_on < $2::date)::int AS overdue,
            count(*) FILTER (WHERE t.due_on BETWEEN $2::date AND $3::date)::int AS due_7d,
            count(*) FILTER (WHERE t.priority IN ('high','urgent'))::int AS high_priority,
            count(*) FILTER (WHERE t.due_on IS NULL)::int AS no_due_date
     FROM tasks t
     WHERE t.status NOT IN ('done','cancelled') AND t.assignee_id = ANY($1::uuid[])
     GROUP BY t.assignee_id`,
    [people.map((p) => p.id), ctx.today, week],
  );
  const by = new Map(rows.map((r) => [r.assignee_id, r]));
  const out = people.map((p) => {
    const r = by.get(p.id) ?? {};
    return {
      person: p.name,
      org: p.org ?? '',
      role: p.role.replace('_', ' '),
      open: r.open ?? 0,
      overdue: r.overdue ?? 0,
      due_7d: r.due_7d ?? 0,
      high_priority: r.high_priority ?? 0,
      no_due_date: r.no_due_date ?? 0,
    };
  });
  out.sort((a, b) => b.open - a.open || a.person.localeCompare(b.person));
  const totals = {
    people: out.length,
    open: out.reduce((s, r) => s + r.open, 0),
    overdue: out.reduce((s, r) => s + r.overdue, 0),
    due_7d: out.reduce((s, r) => s + r.due_7d, 0),
    people_without_tasks: out.filter((r) => r.open === 0).length,
  };
  return {
    workload: dataset(
      `Open work per person (as of ${ctx.today})`,
      [
        col('person', 'Person'),
        col('org', 'Organisation'),
        col('role', 'Role'),
        col('open', 'Open tasks', 'int'),
        col('overdue', 'Overdue', 'int'),
        col('due_7d', 'Due in 7 days', 'int'),
        col('high_priority', 'High priority', 'int'),
        col('no_due_date', 'No due date', 'int'),
      ],
      out,
      totals,
    ),
  };
}

// Attendance --------------------------------------------------------------------------------------

async function attendanceSource(ctx) {
  return memo(ctx, 'attendance', async () => {
    const { rows } = await ctx.client.query(
      `SELECT membership_id, kind, at, (at AT TIME ZONE $3)::date AS day,
              to_char(at AT TIME ZONE $3, 'HH24:MI') AS hm
       FROM attendance_events
       WHERE membership_id = ANY($4::uuid[]) AND (at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
       ORDER BY at`,
      [ctx.from, ctx.to, ctx.tz, ctx.scope.people],
    );
    return rows;
  });
}

/** Per person-day: first in, last out, hours from in→out pairs, missing clock-out. */
export async function attendanceDays(ctx) {
  const events = await attendanceSource(ctx);
  const days = new Map();
  for (const e of events) {
    const key = `${e.membership_id}|${e.day}`;
    const d = days.get(key) ?? { membership_id: e.membership_id, day: e.day, first_in: null, last_out: null, ms: 0, openAt: null };
    if (e.kind === 'in') {
      if (!d.first_in) d.first_in = e.hm;
      if (!d.openAt) d.openAt = new Date(e.at);
    } else {
      d.last_out = e.hm;
      if (d.openAt) {
        d.ms += new Date(e.at) - d.openAt;
        d.openAt = null;
      }
    }
    days.set(key, d);
  }
  return [...days.values()].map((d) => ({
    membership_id: d.membership_id,
    day: d.day,
    first_in: d.first_in,
    last_out: d.last_out,
    hours: round1(d.ms / 3600000),
    missing_out: Boolean(d.openAt) && d.day < ctx.today,
    still_in: Boolean(d.openAt) && d.day === ctx.today,
  }));
}

export async function attendanceDatasets(ctx) {
  const people = await peopleInfo(ctx);
  const names = new Map(people.map((p) => [p.id, p]));
  const days = await attendanceDays(ctx);
  const perPerson = new Map(
    people.map((p) => [p.id, { person: p.name, org: p.org ?? '', days_present: 0, hours: 0, missing_out: 0, first_in_avg: null, _ins: [] }]),
  );
  for (const d of days) {
    const p = perPerson.get(d.membership_id);
    if (!p) continue;
    p.days_present += 1;
    p.hours = round1(p.hours + d.hours);
    if (d.missing_out) p.missing_out += 1;
    if (d.first_in) p._ins.push(d.first_in);
  }
  const personRows = [...perPerson.values()].map(({ _ins, ...p }) => {
    let avg = null;
    if (_ins.length) {
      const mins = _ins.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
      const m = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
      avg = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }
    return { ...p, first_in_avg: avg, avg_hours: p.days_present ? round1(p.hours / p.days_present) : null };
  });
  personRows.sort((a, b) => b.days_present - a.days_present || a.person.localeCompare(b.person));

  const daily = daysBetween(ctx.from, ctx.to).map((date) => ({
    date,
    present: days.filter((d) => d.day === date).length,
  }));
  const log = days
    .map((d) => ({
      date: d.day,
      person: names.get(d.membership_id)?.name ?? '—',
      first_in: d.first_in,
      last_out: d.last_out,
      hours: d.hours,
      note: d.missing_out ? 'no clock-out' : d.still_in ? 'still in' : '',
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));

  const totals = {
    people: people.length,
    people_who_clocked_in: personRows.filter((p) => p.days_present > 0).length,
    person_days: days.length,
    hours: round1(personRows.reduce((s, p) => s + p.hours, 0)),
    missing_clock_outs: days.filter((d) => d.missing_out).length,
  };
  const note = days.length
    ? 'Hours count only clock-in → clock-out pairs. Days without a clock-out are flagged, not estimated.'
    : 'No clock-ins in this period. Attendance is recorded when people clock in and out (web or WhatsApp “@ in” / “@ out”).';
  return {
    attendance_by_person: dataset(
      'Attendance by person',
      [
        col('person', 'Person'),
        col('org', 'Organisation'),
        col('days_present', 'Days present', 'int'),
        col('hours', 'Hours', 'hours'),
        col('avg_hours', 'Avg hours / day', 'hours'),
        col('first_in_avg', 'Usual clock-in', 'time'),
        col('missing_out', 'Missing clock-outs', 'int'),
      ],
      personRows,
      totals,
      note,
    ),
    attendance_daily: dataset('People present per day', [col('date', 'Date', 'date'), col('present', 'Present', 'int')], daily, totals),
    attendance_log: dataset(
      'Daily attendance log',
      [
        col('date', 'Date', 'date'),
        col('person', 'Person'),
        col('first_in', 'In', 'time'),
        col('last_out', 'Out', 'time'),
        col('hours', 'Hours', 'hours'),
        col('note', 'Note'),
      ],
      log,
      totals,
    ),
  };
}

// Sign-ins ----------------------------------------------------------------------------------------

export async function loginDatasets(ctx) {
  const people = await peopleInfo(ctx);
  const names = new Map(people.map((p) => [p.id, p]));
  // Same punches the Timesheet page writes (attendance_events), for every person in scope.
  const events = await attendanceSource(ctx);
  const days = new Map();
  for (const e of events) {
    const key = `${e.membership_id}|${e.day}`;
    const d = days.get(key) ?? { membership_id: e.membership_id, day: e.day, first_in: null, ins: 0, last_out: null, outs: 0 };
    if (e.kind === 'in') {
      d.ins += 1;
      if (!d.first_in) d.first_in = e.hm;
    } else if (e.kind === 'out') {
      d.outs += 1;
      d.last_out = e.hm;
    }
    days.set(key, d);
  }
  const log = [...days.values()]
    .filter((d) => d.ins > 0 || d.outs > 0)
    .map((d) => ({
      date: d.day,
      person: names.get(d.membership_id)?.name ?? '—',
      first_login: d.first_in,
      logins: d.ins,
      last_logout: d.last_out,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.person.localeCompare(b.person));
  const perPerson = new Map(people.map((p) => [p.id, { person: p.name, org: p.org ?? '', active_days: 0, logins: 0, logouts_recorded: 0 }]));
  for (const d of days.values()) {
    const p = perPerson.get(d.membership_id);
    if (!p) continue;
    if (d.ins > 0) p.active_days += 1;
    p.logins += d.ins;
    if (d.outs > 0) p.logouts_recorded += 1;
  }
  const personRows = [...perPerson.values()].sort((a, b) => b.logins - a.logins || b.active_days - a.active_days || a.person.localeCompare(b.person));
  const totals = {
    people: people.length,
    people_signed_in: personRows.filter((p) => p.logins > 0).length,
    logins: personRows.reduce((s, p) => s + p.logins, 0),
    clock_outs: personRows.reduce((s, p) => s + p.logouts_recorded, 0),
  };
  const note = 'Each row is a person in this report. Clock-in and clock-out come from their Timesheet, including people who have not punched in this period.';
  return {
    logins_by_person: dataset(
      'Sign-ins by person',
      [
        col('person', 'Person'),
        col('org', 'Organisation'),
        col('active_days', 'Days clocked in', 'int'),
        col('logins', 'Clock-ins', 'int'),
        col('logouts_recorded', 'Days with clock-out', 'int'),
      ],
      personRows,
      totals,
      note,
    ),
    logins_log: dataset(
      'Daily sign-in log',
      [
        col('date', 'Date', 'date'),
        col('person', 'Person'),
        col('first_login', 'First clock-in', 'time'),
        col('logins', 'Clock-ins', 'int'),
        col('last_logout', 'Last clock-out', 'time'),
      ],
      log,
      totals,
      note,
    ),
  };
}

// Work log (what people recorded in the system) ------------------------------------------------------

export async function workLogDatasets(ctx) {
  const p = [ctx.from, ctx.to, ctx.tz, ctx.scope.people];
  const range = (expr) => `(${expr} AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`;
  const { rows } = await ctx.client.query(
    `SELECT * FROM (
       SELECT t.completed_at AS at, t.assignee_id AS who, 'Task completed' AS kind,
              t.title || ' · ' || pr.name AS detail
       FROM tasks t JOIN projects pr ON pr.id = t.project_id AND pr.workspace_id = t.workspace_id
       WHERE t.status = 'done' AND t.assignee_id = ANY($4::uuid[]) AND ${range('t.completed_at')}
       UNION ALL
       SELECT al.at, al.actor_id, 'Task progress',
              t.title || ' → ' || replace(coalesce(al.payload->>'status', 'updated'), '_', ' ')
       FROM activity_log al JOIN tasks t ON t.id = al.task_id AND t.workspace_id = al.workspace_id
       WHERE al.kind = 'task.updated' AND al.actor_id = ANY($4::uuid[]) AND ${range('al.at')}
       UNION ALL
       SELECT t.created_at, t.created_by, 'Task created', t.title || ' · ' || pr.name
       FROM tasks t JOIN projects pr ON pr.id = t.project_id AND pr.workspace_id = t.workspace_id
       WHERE t.created_by = ANY($4::uuid[]) AND ${range('t.created_at')}
       UNION ALL
       SELECT c.created_at, c.author_id, 'Comment', left(c.body, 140)
       FROM comments c WHERE c.author_id = ANY($4::uuid[]) AND ${range('c.created_at')}
       UNION ALL
       SELECT pu.created_at, pu.author_id, 'Project update', pr.name || ': ' || left(pu.body, 140)
       FROM project_updates pu JOIN projects pr ON pr.id = pu.project_id AND pr.workspace_id = pu.workspace_id
       WHERE pu.author_id = ANY($4::uuid[]) AND ${range('pu.created_at')}
       UNION ALL
       SELECT s.submitted_at, s.submitted_by, 'KPI number',
              k.name || ' = ' || coalesce(s.value::text, '—') || ' (' || to_char(s.period_date, 'DD Mon') || ')'
       FROM submissions s JOIN kpis k ON k.id = s.kpi_id
       WHERE s.submitted_by = ANY($4::uuid[]) AND s.submitted_at IS NOT NULL AND ${range('s.submitted_at')}
     ) e
     ORDER BY at`,
    p,
  );
  const people = await peopleInfo(ctx);
  const names = new Map(people.map((x) => [x.id, x.name]));
  const tzFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const log = rows.map((r) => ({
    date: dayFmt.format(new Date(r.at)),
    time: tzFmt.format(new Date(r.at)),
    person: names.get(r.who) ?? '—',
    kind: r.kind,
    detail: r.detail,
  }));
  const KINDS = ['Task completed', 'Task progress', 'Task created', 'Comment', 'Project update', 'KPI number'];
  const keyOf = { 'Task completed': 'tasks_completed', 'Task progress': 'task_progress', 'Task created': 'tasks_created', Comment: 'comments', 'Project update': 'updates', 'KPI number': 'kpi_numbers' };
  const daily = daysBetween(ctx.from, ctx.to).map((date) => {
    const row = { date, tasks_completed: 0, task_progress: 0, tasks_created: 0, comments: 0, updates: 0, kpi_numbers: 0 };
    for (const e of log) if (e.date === date) row[keyOf[e.kind]] += 1;
    return row;
  });
  const totals = { entries: log.length, active_days: daily.filter((d) => KINDS.some((k) => d[keyOf[k]] > 0)).length };
  for (const k of KINDS) totals[keyOf[k]] = log.filter((e) => e.kind === k).length;
  return {
    work_log: dataset(
      'Work recorded in the system',
      [col('date', 'Date', 'date'), col('time', 'Time', 'time'), col('person', 'Person'), col('kind', 'What'), col('detail', 'Detail')],
      log,
      totals,
      log.length ? null : 'Nothing was recorded in the system in this period.',
    ),
    work_daily: dataset(
      'Activity per day',
      [
        col('date', 'Date', 'date'),
        col('tasks_completed', 'Tasks completed', 'int'),
        col('task_progress', 'Task updates', 'int'),
        col('tasks_created', 'Tasks created', 'int'),
        col('comments', 'Comments', 'int'),
        col('updates', 'Updates', 'int'),
        col('kpi_numbers', 'KPI numbers', 'int'),
      ],
      daily,
      totals,
    ),
  };
}

/** Open tasks due next for the people in scope (for personal reports). */
export async function upcomingDatasets(ctx) {
  const { rows } = await ctx.client.query(
    `SELECT t.title AS task, p.name AS project, t.due_on AS due, t.priority, t.status
     FROM tasks t JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     WHERE t.assignee_id = ANY($1::uuid[]) AND t.status NOT IN ('done','cancelled')
     ORDER BY t.due_on NULLS LAST, t.priority DESC
     LIMIT 25`,
    [ctx.scope.people],
  );
  return {
    upcoming: dataset(
      'Open tasks (as of now)',
      [col('due', 'Due', 'date'), col('task', 'Task'), col('project', 'Project'), col('priority', 'Priority'), col('status', 'Status')],
      rows.map((r) => ({ ...r, status: r.status.replace('_', ' ') })),
      { open: rows.length },
    ),
  };
}

// People scorecard -------------------------------------------------------------------------------

export async function scorecardDatasets(ctx) {
  const people = await peopleInfo(ctx);
  const tasks = await taskDatasets(ctx);
  const { kpis, scores, subs } = await kpiSource(ctx);
  const attendance = await attendanceDays(ctx);
  const taskBy = new Map(tasks.tasks_by_person.rows.map((r) => [r.person, r]));
  const days = daysBetween(ctx.from, ctx.to);

  const rows = people.map((p) => {
    const owned = kpis.filter((k) => k.owner_id === p.id);
    const ownedIds = new Set(owned.map((k) => k.id));
    let good = 0;
    let scored = 0;
    for (const s of scores) {
      if (!ownedIds.has(s.kpi_id) || s.rag === 'unscored') continue;
      scored += 1;
      if (s.rag === 'green') good += 1;
    }
    let expected = 0;
    let received = 0;
    for (const k of owned) {
      const exp = expectedBuckets(k.how_often, days, ctx.to);
      const got = new Set(
        subs.filter((s) => s.kpi_id === k.id && DONE_STATES.includes(s.state)).map((s) => bucketKey(k.how_often, s.period_date)),
      );
      expected += exp.size;
      received += [...got].filter((b) => exp.has(b)).length;
    }
    const t = taskBy.get(p.name) ?? {};
    const att = attendance.filter((a) => a.membership_id === p.id);
    return {
      person: p.name,
      org: p.org ?? '',
      role: p.role.replace('_', ' '),
      tasks_completed: t.completed ?? 0,
      on_time_rate: t.on_time_rate ?? null,
      overdue: t.overdue ?? 0,
      kpis_owned: owned.length,
      kpi_attainment: rate(good, scored),
      reporting_rate: rate(received, expected),
      days_present: att.length,
      hours: round1(att.reduce((s, a) => s + a.hours, 0)),
    };
  });
  rows.sort((a, b) => b.tasks_completed - a.tasks_completed || a.person.localeCompare(b.person));
  const totals = {
    people: rows.length,
    tasks_completed: rows.reduce((s, r) => s + r.tasks_completed, 0),
    overdue: rows.reduce((s, r) => s + r.overdue, 0),
    kpis_owned: rows.reduce((s, r) => s + r.kpis_owned, 0),
  };
  return {
    scorecard: dataset(
      'People scorecard',
      [
        col('person', 'Person'),
        col('org', 'Organisation'),
        col('role', 'Role'),
        col('tasks_completed', 'Tasks done', 'int'),
        col('on_time_rate', 'On time', 'pct'),
        col('overdue', 'Overdue', 'int'),
        col('kpis_owned', 'KPIs owned', 'int'),
        col('kpi_attainment', 'KPI attainment', 'pct'),
        col('reporting_rate', 'Reporting', 'pct'),
        col('days_present', 'Days present', 'int'),
        col('hours', 'Hours', 'hours'),
      ],
      rows,
      totals,
      'Blank = nothing to measure (no due dates, no KPIs owned, or no clock-ins).',
    ),
    ...tasks,
  };
}
