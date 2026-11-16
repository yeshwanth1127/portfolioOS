import {
  deliveryScopeSql,
  daysInRange,
  milestoneScopeSql,
} from './scope.js';

function measureShell(scope, extras = {}) {
  return {
    as_of: scope.asOf,
    coverage: 0,
    drill_down: { measure: extras.measure, ...extras.drill },
    value: extras.value ?? {},
    ...extras.meta,
  };
}

function roundRate(num, den) {
  if (!den) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Task completion: done vs open (excludes cancelled) in delivery scope.
 * Coverage = share of tasks that have an assignee among in-scope non-cancelled tasks.
 */
export async function taskCompletion(client, scope) {
  const { where, params } = deliveryScopeSql(scope, 1);
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE t.status = 'done')::int AS done,
       count(*) FILTER (WHERE t.status NOT IN ('done','cancelled'))::int AS open,
       count(*) FILTER (WHERE t.status <> 'cancelled')::int AS total,
       count(*) FILTER (WHERE t.status <> 'cancelled' AND t.assignee_id IS NOT NULL)::int AS assigned
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE TRUE ${where}`,
    params,
  );
  const r = rows[0] ?? {};
  const total = r.total ?? 0;
  const coverage = roundRate(r.assigned ?? 0, total) ?? 0;
  return measureShell(scope, {
    measure: 'task_completion',
    drill: { status: 'open' },
    value: {
      done: r.done ?? 0,
      open: r.open ?? 0,
      total,
      completion_rate: roundRate(r.done ?? 0, (r.done ?? 0) + (r.open ?? 0)),
    },
    meta: { coverage },
  });
}

/** Target attainment: KPI scores (green / amber / red against their goals) for as_of. */
export async function targetAttainment(client, scope) {
  const drill = { measure: 'target_attainment' };
  const orgFilter = scope.orgId ? ' AND s.org_id = $2' : '';
  const params = [scope.asOf];
  if (scope.orgId) params.push(scope.orgId);
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE s.rag = 'green')::int AS good,
       count(*) FILTER (WHERE s.rag = 'amber')::int AS watch,
       count(*) FILTER (WHERE s.rag = 'red')::int AS bad,
       count(*)::int AS total
     FROM scores s
     JOIN kpis k ON k.id = s.kpi_id
     WHERE s.period_date = $1${orgFilter}`,
    params,
  );
  const r = rows[0] ?? {};
  const value = {
    good: r.good ?? 0,
    watch: r.watch ?? 0,
    bad: r.bad ?? 0,
    total: r.total ?? 0,
    provenance: 'kpi_scores',
  };
  const coverage = r.total ? 1 : 0;

  const shell = measureShell(scope, { measure: 'target_attainment', drill, value });
  shell.coverage = coverage;
  return shell;
}

/**
 * On-time delivery (documented definition):
 * Among tasks and milestones with due_on in [from, to], terminal items (done) are on-time when
 * completed_at::date <= due_on (timezone: workspace). Open items with due_on < as_of count as late (not delivered).
 */
async function onTimeSlice(client, scope, entity, scopeSql) {
  const alias = entity === 'task' ? 't' : 'm';
  const table = entity === 'task' ? 'tasks' : 'milestones';
  const { where, params } = scopeSql(scope, 5);
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE ${alias}.status = 'done'
         AND (${alias}.completed_at AT TIME ZONE $3)::date <= ${alias}.due_on)::int AS on_time,
       count(*) FILTER (WHERE ${alias}.status = 'done'
         AND (${alias}.completed_at AT TIME ZONE $3)::date > ${alias}.due_on)::int AS late_done,
       count(*) FILTER (WHERE ${alias}.status <> 'done' AND ${alias}.due_on < $4::date)::int AS open_overdue,
       count(*) FILTER (WHERE ${alias}.status = 'done')::int AS delivered,
       count(*)::int AS due_total
     FROM ${table} ${alias}
     JOIN projects p ON p.id = ${alias}.project_id AND p.workspace_id = ${alias}.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE ${alias}.due_on IS NOT NULL
       AND ${alias}.due_on BETWEEN $1::date AND $2::date
       AND ${alias}.status <> 'cancelled'
       ${where}`,
    [scope.from, scope.to, scope.tz, scope.asOf, ...params],
  );
  return rows[0] ?? {};
}

export async function onTimeDelivery(client, scope) {
  const task = await onTimeSlice(client, scope, 'task', deliveryScopeSql);
  const mile = await onTimeSlice(client, scope, 'milestone', milestoneScopeSql);
  const r = {
    on_time: (task.on_time ?? 0) + (mile.on_time ?? 0),
    late_done: (task.late_done ?? 0) + (mile.late_done ?? 0),
    open_overdue: (task.open_overdue ?? 0) + (mile.open_overdue ?? 0),
    delivered: (task.delivered ?? 0) + (mile.delivered ?? 0),
    due_total: (task.due_total ?? 0) + (mile.due_total ?? 0),
  };
  const delivered = r.delivered ?? 0;
  const onTime = r.on_time ?? 0;
  const dueTotal = r.due_total ?? 0;
  return measureShell(scope, {
    measure: 'on_time_delivery',
    drill: { late: 'true' },
    value: {
      on_time: onTime,
      late_done: r.late_done ?? 0,
      open_overdue: r.open_overdue ?? 0,
      delivered,
      due_total: dueTotal,
      on_time_rate: roundRate(onTime, delivered),
    },
    meta: {
      coverage: roundRate(delivered, dueTotal) ?? 0,
      definition:
        'done items with completed_at on or before due_on; open items past as_of with due in range count as open_overdue',
    },
  });
}

/**
 * Reporting completeness: expected vs received in [from, to].
 * Expected = (kpi × day) in range; received = submissions in submitted/validated/locked.
 */
export async function reportingCompleteness(client, scope) {
  const drill = { measure: 'reporting_completeness' };

  const days = daysInRange(scope.from, scope.to);
  const orgFilter = scope.orgId ? ' AND k.org_id = $1' : '';
  const kpiParams = scope.orgId ? [scope.orgId] : [];
  const { rows: kpis } = await client.query(
    `SELECT k.id FROM kpis k WHERE TRUE${orgFilter}`,
    kpiParams,
  );
  const expected = (kpis?.length ?? 0) * days.length;
  const subParams = [scope.from, scope.to, ...(scope.orgId ? [scope.orgId] : [])];
  const { rows: subs } = await client.query(
    `SELECT count(*)::int AS received
     FROM submissions s
     JOIN kpis k ON k.id = s.kpi_id
     WHERE s.period_date BETWEEN $1::date AND $2::date
       AND s.state IN ('submitted','validated','locked')
       ${scope.orgId ? 'AND s.org_id = $3' : ''}`,
    subParams,
  );
  const received = subs[0]?.received ?? 0;
  return measureShell(scope, {
    measure: 'reporting_completeness',
    drill,
    value: {
      expected,
      received,
      rate: roundRate(received, expected),
      source: 'legacy_submissions',
      days: days.length,
      kpis: kpis?.length ?? 0,
    },
    meta: { coverage: roundRate(received, expected) ?? 0 },
  });
}

export async function allMeasures(client, scope) {
  const [task_completion, target_attainment, on_time_delivery, reporting_completeness] = await Promise.all([
    taskCompletion(client, scope),
    targetAttainment(client, scope),
    onTimeDelivery(client, scope),
    reportingCompleteness(client, scope),
  ]);
  return { task_completion, target_attainment, on_time_delivery, reporting_completeness };
}
