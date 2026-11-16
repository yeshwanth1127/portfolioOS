/*
 * Report types: who may run each one, which datasets it needs, how it is laid out, and the
 * plain summary used when the agent is unavailable. Adding a module = add a dataset builder in
 * datasets.js and a type here.
 */
import {
  attendanceDatasets,
  kpiDatasets,
  loginDatasets,
  projectDatasets,
  reportingDatasets,
  scorecardDatasets,
  taskDatasets,
  upcomingDatasets,
  workLogDatasets,
  workloadDatasets,
} from './datasets.js';

const LEADS = ['owner', 'manager', 'vice_manager', 'team_lead'];
const EVERYONE = [...LEADS, 'member'];

// Layout helpers ------------------------------------------------------------------------------------
const tile = (label, value, format = 'int', tone = null) => ({ label, value, format, tone });
const tiles = (items) => ({ kind: 'tiles', items: items.filter(Boolean) });
const chart = (type, dataset, x, series, opts = {}) => ({ kind: 'chart', type, dataset, x, series, ...opts });
const table = (dataset, opts = {}) => ({ kind: 'table', dataset, ...opts });
const section = (key, title, blocks) => ({ key, title, blocks: blocks.filter(Boolean) });
const s = (key, label, tone) => ({ key, label, tone });

/** Formatted number for template sentences (matches how the page shows it). */
export function fmt(value, format = 'int') {
  if (value == null || Number.isNaN(value)) return '—';
  if (format === 'pct') return `${Math.round(Number(value) * 100)}%`;
  if (format === 'hours') return `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`;
  if (typeof value === 'number') return value.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return String(value);
}
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export const REPORT_TYPES = [
  {
    id: 'kpi_performance',
    label: 'KPI targets',
    description: 'Which KPIs hit target, which slipped, by day and organisation.',
    icon: 'target',
    roles: LEADS,
    build: (ctx) => kpiDatasets(ctx),
    layout: (d, ctx) => [
      section('overview', 'Overview', [
        tiles([
          tile('KPIs', d.kpi_by_kpi.totals.kpis),
          tile('Attainment', d.kpi_by_kpi.totals.attainment, 'pct', 'primary'),
          tile('Good', d.kpi_by_kpi.totals.good, 'int', 'good'),
          tile('Watch', d.kpi_by_kpi.totals.watch, 'int', 'watch'),
          tile('Bad', d.kpi_by_kpi.totals.bad, 'int', 'bad'),
          tile('Off track now', d.kpi_by_kpi.totals.off_track_now, 'int', 'bad'),
        ]),
        chart('stacked', 'kpi_trend', 'date', [s('good', 'Good', 'good'), s('watch', 'Watch', 'watch'), s('bad', 'Bad', 'bad')]),
      ]),
      ctx.scope.kind === 'workspace'
        ? section('orgs', 'By organisation', [
            chart('bar', 'kpi_by_org', 'org', [s('attainment', 'Attainment', 'primary')], { format: 'pct' }),
            table('kpi_by_org'),
          ])
        : null,
      section('kpis', 'Every KPI', [table('kpi_by_kpi')]),
    ],
    summary: (d) => {
      const t = d.kpi_by_kpi.totals;
      if (!t.kpis) return ['No active KPIs in this scope.'];
      if (!t.scored_points) return [`${plural(t.kpis, 'KPI')} in scope, but none were scored in this period.`];
      return [
        `${fmt(t.attainment, 'pct')} of scored KPI periods were good (${fmt(t.good)} good, ${fmt(t.watch)} watch, ${fmt(t.bad)} bad) across ${plural(t.kpis, 'KPI')}.`,
        t.off_track_now ? `${plural(t.off_track_now, 'KPI')} ended the period off track.` : 'No KPI ended the period off track.',
        t.kpis_never_scored ? `${plural(t.kpis_never_scored, 'KPI')} had no score at all in the period.` : null,
      ];
    },
  },
  {
    id: 'reporting',
    label: 'KPI reporting',
    description: 'Did people enter their numbers on time? Expected vs received.',
    icon: 'check',
    roles: LEADS,
    build: (ctx) => reportingDatasets(ctx),
    layout: (d, ctx) => [
      section('overview', 'Overview', [
        tiles([
          tile('Expected', d.reporting_by_person.totals.expected),
          tile('Received', d.reporting_by_person.totals.received, 'int', 'good'),
          tile('Missing', d.reporting_by_person.totals.missing, 'int', 'bad'),
          tile('Completeness', d.reporting_by_person.totals.rate, 'pct', 'primary'),
          tile('Awaiting approval', d.reporting_by_person.totals.pending_approval, 'int', 'watch'),
        ]),
        chart('stacked', 'reporting_trend', 'date', [s('received', 'Received', 'good'), s('missing', 'Missing', 'bad')]),
      ]),
      ctx.scope.kind === 'workspace' ? section('orgs', 'By organisation', [table('reporting_by_org')]) : null,
      section('people', 'By owner', [table('reporting_by_person')]),
    ],
    summary: (d) => {
      const t = d.reporting_by_person.totals;
      if (!t.expected) return ['No KPI numbers were due in this period.'];
      return [
        `${fmt(t.received)} of ${fmt(t.expected)} expected KPI numbers were entered (${fmt(t.rate, 'pct')}); ${fmt(t.missing)} are missing.`,
        t.pending_approval ? `${fmt(t.pending_approval)} entries are still awaiting approval.` : null,
      ];
    },
  },
  {
    id: 'task_delivery',
    label: 'Tasks & delivery',
    description: 'Tasks completed, on-time rate, open and overdue work.',
    icon: 'check',
    roles: EVERYONE,
    build: (ctx) => taskDatasets(ctx),
    layout: (d, ctx) => [
      section('overview', 'Overview', [
        tiles([
          tile('Completed', d.tasks_by_person.totals.completed, 'int', 'good'),
          tile('On time', d.tasks_by_person.totals.on_time_rate, 'pct', 'primary'),
          tile('New tasks', d.tasks_by_person.totals.assigned_in_period),
          tile('Open now', d.tasks_by_person.totals.open),
          tile('Overdue', d.tasks_by_person.totals.overdue, 'int', 'bad'),
        ]),
        chart('bar', 'tasks_trend', 'date', [s('completed', 'Completed', 'good')]),
      ]),
      ctx.scope.people.length > 1 ? section('people', 'By person', [table('tasks_by_person')]) : null,
      section('overdue', 'Overdue', [table('tasks_overdue', { limit: 25 })]),
      section('done', 'Completed', [table('tasks_completed', { limit: 50 })]),
    ],
    summary: (d) => {
      const t = d.tasks_by_person.totals;
      return [
        `${plural(t.completed, 'task')} completed${t.on_time + t.late ? `, ${fmt(t.on_time_rate, 'pct')} of those with a due date on time` : ''}.`,
        `${fmt(t.open)} open, ${fmt(t.overdue)} overdue.`,
      ];
    },
  },
  {
    id: 'projects',
    label: 'Projects & milestones',
    description: 'Progress per project and milestones due in the period.',
    icon: 'folder',
    roles: LEADS,
    build: (ctx) => projectDatasets(ctx),
    layout: (d) => [
      section('overview', 'Overview', [
        tiles([
          tile('Projects', d.projects_progress.totals.projects),
          tile('Tasks done', d.projects_progress.totals.tasks_done_in_period, 'int', 'good'),
          tile('Overdue tasks', d.projects_progress.totals.overdue_tasks, 'int', 'bad'),
          tile('Milestones due', d.milestones.totals.milestones_due),
          tile('Milestones on time', d.milestones.totals.milestones_on_time, 'int', 'good'),
        ]),
        chart('bar', 'projects_progress', 'project', [s('progress', 'Progress', 'primary')], { format: 'pct', limit: 15 }),
      ]),
      section('projects', 'Projects', [table('projects_progress')]),
      section('milestones', 'Milestones', [table('milestones')]),
    ],
    summary: (d) => {
      const t = d.projects_progress.totals;
      return [
        `${plural(t.projects, 'project')} in scope; ${plural(t.tasks_done_in_period, 'task')} done in the period and ${fmt(t.overdue_tasks)} overdue.`,
        t.milestones_due
          ? `${fmt(t.milestones_on_time)} of ${fmt(t.milestones_due)} milestones due were met on time.`
          : 'No milestones were due in the period.',
      ];
    },
  },
  {
    id: 'workload',
    label: 'Workload & assignments',
    description: 'Who holds how much open work right now.',
    icon: 'users',
    roles: LEADS,
    build: (ctx) => workloadDatasets(ctx),
    layout: () => [
      section('overview', 'Overview', [
        { kind: 'tiles', items: [], from: 'workload', fields: ['open', 'overdue', 'due_7d', 'people_without_tasks'] },
        chart('stacked', 'workload', 'person', [s('overdue', 'Overdue', 'bad'), s('due_7d', 'Due in 7 days', 'watch')], { limit: 15 }),
      ]),
      section('people', 'By person', [table('workload')]),
    ],
    summary: (d) => {
      const t = d.workload.totals;
      return [
        `${plural(t.open, 'open task')} across ${plural(t.people, 'person', 'people')}; ${fmt(t.overdue)} overdue and ${fmt(t.due_7d)} due in the next 7 days.`,
        t.people_without_tasks ? `${plural(t.people_without_tasks, 'person', 'people')} have no open tasks.` : null,
      ];
    },
  },
  {
    id: 'people',
    label: 'People scorecard',
    description: 'One line per person: tasks, KPIs, reporting, attendance.',
    icon: 'team',
    roles: LEADS,
    build: (ctx) => scorecardDatasets(ctx),
    layout: () => [
      section('overview', 'Overview', [chart('bar', 'scorecard', 'person', [s('tasks_completed', 'Tasks done', 'primary')], { limit: 15 })]),
      section('people', 'Scorecard', [table('scorecard')]),
    ],
    summary: (d) => {
      const t = d.scorecard.totals;
      return [`${plural(t.people, 'person', 'people')} in scope completed ${plural(t.tasks_completed, 'task')}; ${fmt(t.overdue)} tasks are overdue.`];
    },
  },
  {
    id: 'attendance',
    label: 'Attendance',
    description: 'Clock-in and clock-out times, days present, hours.',
    icon: 'calendar',
    roles: LEADS,
    build: (ctx) => attendanceDatasets(ctx),
    layout: () => [
      section('overview', 'Overview', [
        { kind: 'tiles', items: [], from: 'attendance_by_person', fields: ['people_who_clocked_in', 'person_days', 'hours', 'missing_clock_outs'] },
        chart('bar', 'attendance_daily', 'date', [s('present', 'Present', 'primary')]),
      ]),
      section('people', 'By person', [table('attendance_by_person')]),
      section('log', 'Daily log', [table('attendance_log', { limit: 200 })]),
    ],
    summary: (d) => {
      const t = d.attendance_by_person.totals;
      if (!t.person_days) return ['Nobody clocked in during this period.'];
      return [
        `${plural(t.people_who_clocked_in, 'person', 'people')} clocked in on ${plural(t.person_days, 'person-day')}, ${fmt(t.hours, 'hours')} in total.`,
        t.missing_clock_outs ? `${plural(t.missing_clock_outs, 'day')} had no clock-out.` : null,
      ];
    },
  },
  {
    id: 'logins',
    label: 'Sign-ins',
    description: 'Clock-in and clock-out from each person’s Timesheet.',
    icon: 'user',
    roles: ['owner'],
    build: (ctx) => loginDatasets(ctx),
    layout: () => [
      section('overview', 'Overview', [
        { kind: 'tiles', items: [], from: 'logins_by_person', fields: ['people_signed_in', 'logins', 'clock_outs'] },
      ]),
      section('people', 'By person', [table('logins_by_person')]),
      section('log', 'Daily log', [table('logins_log', { limit: 200 })]),
    ],
    summary: (d) => {
      const t = d.logins_by_person.totals;
      return [`${plural(t.people_signed_in, 'person', 'people')} of ${fmt(t.people)} clocked in on their Timesheet (${plural(t.logins, 'clock-in')}, ${plural(t.clock_outs, 'day', 'days')} with a clock-out).`];
    },
  },
  {
    id: 'my_work',
    label: 'Work report',
    description: 'Everything recorded for a day, week or month: tasks, updates, numbers, hours.',
    icon: 'check',
    roles: EVERYONE,
    personal: true,
    build: async (ctx) => ({
      ...(await workLogDatasets(ctx)),
      ...(await taskDatasets(ctx)),
      ...(await upcomingDatasets(ctx)),
      ...(await attendanceDatasets(ctx)),
    }),
    layout: (d) => [
      section('overview', 'Overview', [
        tiles([
          tile('Tasks completed', d.tasks_by_person.totals.completed, 'int', 'good'),
          tile('On time', d.tasks_by_person.totals.on_time_rate, 'pct', 'primary'),
          tile('KPI numbers', d.work_log.totals.kpi_numbers),
          tile('Updates & comments', d.work_log.totals.updates + d.work_log.totals.comments),
          tile('Overdue', d.tasks_by_person.totals.overdue, 'int', 'bad'),
          d.attendance_by_person.totals.person_days ? tile('Hours', d.attendance_by_person.totals.hours, 'hours') : null,
        ]),
        chart('stacked', 'work_daily', 'date', [
          s('tasks_completed', 'Tasks completed', 'good'),
          s('task_progress', 'Task updates', 'soft'),
          s('kpi_numbers', 'KPI numbers', 'primary'),
          s('updates', 'Updates', 'watch'),
          s('comments', 'Comments', 'muted'),
        ]),
      ]),
      section('done', 'Completed', [table('tasks_completed', { limit: 100 })]),
      section('log', 'Everything recorded', [table('work_log', { limit: 300 })]),
      section('next', 'Open and overdue', [table('tasks_overdue', { limit: 25 }), table('upcoming')]),
      d.attendance_log.rows.length ? section('attendance', 'Attendance', [table('attendance_log')]) : null,
    ],
    summary: (d) => {
      const w = d.work_log.totals;
      const t = d.tasks_by_person.totals;
      const a = d.attendance_by_person.totals;
      if (!w.entries && !a.person_days) return ['Nothing was recorded in the system for this period.'];
      return [
        `${plural(t.completed, 'task')} completed, ${plural(w.kpi_numbers, 'KPI number')} entered, ${plural(w.updates, 'project update')} and ${plural(w.comments, 'comment')} posted.`,
        a.person_days ? `${fmt(a.hours, 'hours')} clocked over ${plural(a.person_days, 'day')}.` : null,
        t.overdue ? `${plural(t.overdue, 'task')} overdue at the end of the period.` : null,
      ];
    },
  },
];

export const TYPE_BY_ID = new Map(REPORT_TYPES.map((t) => [t.id, t]));

export function typesFor(role) {
  return REPORT_TYPES.filter((t) => t.roles.includes(role));
}

/** Expand `{ from, fields }` tile shorthands using a dataset's totals. */
const FIELD_LABELS = {
  open: ['Open tasks', 'int'],
  overdue: ['Overdue', 'int', 'bad'],
  due_7d: ['Due in 7 days', 'int', 'watch'],
  people_without_tasks: ['No open tasks', 'int'],
  people_who_clocked_in: ['People clocked in', 'int', 'primary'],
  person_days: ['Person-days', 'int'],
  hours: ['Hours', 'hours'],
  missing_clock_outs: ['Missing clock-outs', 'int', 'bad'],
  people_signed_in: ['People clocked in', 'int', 'primary'],
  logins: ['Clock-ins', 'int'],
  clock_outs: ['Days with a clock-out', 'int'],
};

export function buildLayout(type, datasets, ctx) {
  return type.layout(datasets, ctx)
    .filter(Boolean)
    .map((sec) => ({
      ...sec,
      blocks: sec.blocks.map((b) => {
        if (b.kind !== 'tiles' || !b.from) return b;
        const totals = datasets[b.from]?.totals ?? {};
        return tiles(
          b.fields.map((f) => {
            const [label, format, tone] = FIELD_LABELS[f] ?? [f, 'int'];
            return tile(label, totals[f] ?? null, format, tone ?? null);
          }),
        );
      }),
    }));
}

export function templateSummary(type, datasets) {
  return type.summary(datasets).filter(Boolean).join(' ');
}
