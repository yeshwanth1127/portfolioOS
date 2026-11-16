import { addDays, todayIn } from '../core/dates.js';
import { parseDashboardQuery } from './dashboards/scope.js';
import { allMeasures } from './dashboards/measures.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function greetingName(membership) {
  const first = String(membership.full_name ?? '').trim().split(/\s+/)[0] || 'there';
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return { name: first, part };
}

/**
 * Overview v1 (docs/BUILD.md § 6.7) — one payload for the home screen on current KPI/score tables.
 */
export async function overviewDashboard(client, membership, date) {
  const tz = membership.workspace_timezone ?? 'Asia/Kolkata';
  const asOf = date && ISO.test(date) ? date : todayIn(tz);
  const greet = greetingName(membership);

  const owner = membership.role === 'owner';
  const dateParams = owner ? [asOf] : [asOf, membership.org_id];
  const orgFilter = owner ? '' : ' AND o.id = $2';
  const scoreFilter = owner ? '' : ' AND s.org_id = $2';
  const escFilter = owner ? '' : ' AND e.org_id = $1';
  const escParams = owner ? [] : [membership.org_id];

  const { rows: dayRows } = await client.query(
    `SELECT o.id, o.short_name AS org, o.slug,
            COALESCE(p.status, 'open') AS status
     FROM organisations o
     LEFT JOIN org_periods p ON p.org_id = o.id AND p.period_date = $1
     WHERE TRUE ${orgFilter}
     ORDER BY o.short_name`,
    dateParams,
  );
  const locked = dayRows.filter((r) => r.status === 'locked').length;
  const open = dayRows.length - locked;

  // Today by organisation: where each organisation's day stands, and how its daily numbers
  // compare with the daily goals. Expected numbers = active KPIs submitted every day (or, for an
  // organisation that only tracks weekly / monthly measures, all of its active KPIs).
  const { rows: dayDetail } = await client.query(
    `SELECT o.id, o.short_name AS org, o.slug,
            COALESCE(p.status, 'open') AS status,
            (SELECT count(*)::int FROM kpis k
              WHERE k.org_id = o.id AND k.status = 'active' AND k.how_often = 'Every day') AS expected_daily,
            (SELECT count(*)::int FROM kpis k WHERE k.org_id = o.id AND k.status = 'active') AS measures,
            (SELECT count(DISTINCT s.kpi_id)::int FROM submissions s
              WHERE s.org_id = o.id AND s.period_date = $1 AND s.value IS NOT NULL
                AND s.state IN ('submitted', 'validated', 'locked')) AS entered,
            (SELECT count(DISTINCT s.kpi_id)::int FROM submissions s
              WHERE s.org_id = o.id AND s.period_date = $1 AND s.value IS NOT NULL
                AND s.state IN ('validated', 'locked')) AS validated,
            (SELECT count(*)::int FROM kpi_goals g JOIN kpis k ON k.id = g.kpi_id
              WHERE k.org_id = o.id AND k.status = 'active' AND g.how_often = 'Every day' AND g.target IS NOT NULL) AS goals_set,
            (SELECT count(*)::int FROM kpi_goals g
               JOIN kpis k ON k.id = g.kpi_id
               JOIN LATERAL (
                 SELECT s.value FROM submissions s
                 WHERE s.kpi_id = k.id AND s.period_date = $1 AND s.value IS NOT NULL
                   AND s.state IN ('submitted', 'validated', 'locked')
                 ORDER BY (s.state IN ('validated', 'locked')) DESC,
                          CASE s.level WHEN 'owner' THEN 5 WHEN 'manager' THEN 4 WHEN 'vice_manager' THEN 3
                                       WHEN 'team_lead' THEN 2 ELSE 1 END DESC
                 LIMIT 1
               ) v ON TRUE
              WHERE k.org_id = o.id AND k.status = 'active' AND g.how_often = 'Every day' AND g.target IS NOT NULL
                AND CASE WHEN k.direction = 'lower_is_better' THEN v.value <= g.target ELSE v.value >= g.target END
            ) AS goals_met
     FROM organisations o
     LEFT JOIN org_periods p ON p.org_id = o.id AND p.period_date = $1
     WHERE TRUE ${orgFilter}
     ORDER BY o.short_name`,
    dateParams,
  );
  for (const r of dayDetail) r.expected = r.expected_daily || r.measures;
  const dayStage = (r) => {
    if (r.status === 'locked') return 'locked';
    if (r.expected > 0 && r.validated >= r.expected) return 'ready';
    if (r.entered > 0) return 'in_progress';
    return 'not_started';
  };
  const today = dayDetail.map((r) => ({
    org: r.org,
    slug: r.slug,
    stage: dayStage(r),
    expected: r.expected,
    entered: r.entered,
    validated: r.validated,
    goals_set: r.goals_set,
    goals_met: r.goals_met,
  }));

  const { rows: bars } = await client.query(
    `SELECT o.short_name AS org,
            count(*) FILTER (WHERE s.rag = 'green')::int AS good,
            count(*) FILTER (WHERE s.rag = 'amber')::int AS watch,
            count(*) FILTER (WHERE s.rag = 'red')::int AS bad
     FROM scores s
     JOIN organisations o ON o.id = s.org_id
     WHERE s.period_date = $1 ${scoreFilter}
     GROUP BY o.short_name
     ORDER BY o.short_name`,
    dateParams,
  );

  const attentionOrgs = bars.filter((b) => b.bad > 0 || b.watch > 0).length;

  const { rows: series } = await client.query(
    `SELECT s.period_date AS date,
            round(avg(CASE s.rag WHEN 'green' THEN 1.0 WHEN 'amber' THEN 0.5 ELSE 0 END)::numeric, 3) AS good_share
     FROM scores s
     JOIN organisations o ON o.id = s.org_id
     WHERE s.period_date BETWEEN ($1::date - 13) AND $1::date ${scoreFilter}
     GROUP BY s.period_date
     ORDER BY s.period_date`,
    dateParams,
  );
  const shares = series.map((r) => Number(r.good_share));
  const performance = {
    series,
    avg: shares.length ? Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 100) / 100 : null,
    min: shares.length ? Math.min(...shares) : null,
    max: shares.length ? Math.max(...shares) : null,
  };

  const { rows: reporting } = await client.query(
    `SELECT
       count(*) FILTER (WHERE s.state IN ('submitted','validated','locked'))::int AS submitted,
       count(*) FILTER (WHERE s.state = 'submitted')::int AS awaiting_review,
       count(*) FILTER (WHERE s.state = 'draft')::int AS missing
     FROM submissions s
     JOIN organisations o ON o.id = s.org_id
     WHERE s.period_date = $1 ${scoreFilter}`,
    dateParams,
  );

  const { rows: escalations } = await client.query(
    `SELECT count(*)::int AS c FROM escalations e JOIN organisations o ON o.id = e.org_id
     WHERE e.state = 'open' ${escFilter}`,
    escParams,
  );

  const { rows: awaitingLock } = await client.query(
    `SELECT count(DISTINCT (s.org_id, s.period_date))::int AS c
     FROM submissions s
     JOIN organisations o ON o.id = s.org_id
     LEFT JOIN org_periods p ON p.org_id = s.org_id AND p.period_date = s.period_date
     WHERE s.period_date < $1 AND COALESCE(p.status, 'open') = 'open' ${scoreFilter}`,
    dateParams,
  );

  const { rows: attention } = await client.query(
    `SELECT k.id, k.code, k.name AS title, o.short_name AS org, s.rag, s.value, s.goal,
            auth.workspace_member_name(k.owner_id) AS owner
     FROM scores s
     JOIN kpis k ON k.id = s.kpi_id
     JOIN organisations o ON o.id = k.org_id
     WHERE s.period_date = $1 AND s.rag IN ('red', 'amber') ${scoreFilter}
     ORDER BY CASE s.rag WHEN 'red' THEN 0 ELSE 1 END, o.short_name, k.name
     LIMIT 8`,
    dateParams,
  );

  const { rows: eventsToday } = await client.query(
    `SELECT count(*)::int AS c FROM calendar_events e
     WHERE e.starts_at < (($1::date + 1)::timestamp AT TIME ZONE $2)
       AND e.ends_at >= ($1::date::timestamp AT TIME ZONE $2)`,
    [asOf, tz],
  );

  const pending = reporting[0]?.awaiting_review ?? 0;
  const isToday = asOf >= todayIn(tz);
  const dayWord = isToday ? 'today' : 'that day';
  const parts = [];
  if (membership.role === 'owner' && attentionOrgs) parts.push(`${attentionOrgs} organisation${attentionOrgs === 1 ? '' : 's'} need attention`);
  if (pending) parts.push(`${pending} approval${pending === 1 ? '' : 's'} waiting`);
  if (eventsToday[0]?.c) parts.push(`${eventsToday[0].c} event${eventsToday[0].c === 1 ? '' : 's'} ${dayWord}`);

  const coverageDenom = bars.reduce((n, b) => n + b.good + b.watch + b.bad, 0);
  const coverage = coverageDenom
    ? Math.round((bars.reduce((n, b) => n + b.good, 0) / coverageDenom) * 100) / 100
    : 0;

  const soon = addDays(asOf, 14);
  const deliveryOrgFilter = owner ? '' : ' AND u.legacy_org_id = $2';
  const deliveryMilestoneOrgFilter = owner ? '' : ' AND u.legacy_org_id = $3';
  const deliveryTaskParams = owner ? [asOf] : [asOf, membership.org_id];
  const deliveryMilestoneParams = owner ? [asOf, soon] : [asOf, soon, membership.org_id];

  const { rows: deliveryRows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE t.status NOT IN ('done','cancelled'))::int AS open_tasks,
       count(*) FILTER (
         WHERE t.status NOT IN ('done','cancelled') AND t.due_on IS NOT NULL AND t.due_on < $1::date
       )::int AS overdue_tasks
     FROM tasks t
     JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE TRUE ${deliveryOrgFilter}`,
    deliveryTaskParams,
  );
  const { rows: milestoneSoon } = await client.query(
    `SELECT count(*)::int AS c
     FROM milestones m
     JOIN projects p ON p.id = m.project_id AND p.workspace_id = m.workspace_id
     JOIN units u ON u.id = p.unit_id AND u.workspace_id = p.workspace_id
     WHERE m.status = 'open'
       AND m.due_on IS NOT NULL
       AND m.due_on BETWEEN $1::date AND $2::date
       ${deliveryMilestoneOrgFilter}`,
    deliveryMilestoneParams,
  );

  const scope = parseDashboardQuery(membership, { date }, { kind: owner ? 'workspace' : 'workspace' });
  const measures = scope.err ? null : await allMeasures(client, scope);

  return {
    greeting: {
      ...greet,
      summary: parts.length ? parts.join(' · ') : `All clear for ${isToday ? 'today' : 'that day'}.`,
    },
    organisations: { locked, open, attention: attentionOrgs, bars, today },
    performance,
    reporting: reporting[0] ?? { submitted: 0, awaiting_review: 0, missing: 0 },
    approvals: {
      pending,
      escalations: escalations[0]?.c ?? 0,
      days_awaiting_lock: awaitingLock[0]?.c ?? 0,
    },
    attention: attention.map((row) => ({
      type: 'kpi',
      id: row.id,
      title: row.title,
      org: row.org,
      status: row.rag === 'red' ? 'bad' : 'watch',
      value: row.value,
      goal: row.goal,
      owner: row.owner,
    })),
    as_of: asOf,
    timezone: tz,
    coverage,
    target_attainment: {
      good: measures?.target_attainment?.value?.good ?? 0,
      watch: measures?.target_attainment?.value?.watch ?? 0,
      bad: measures?.target_attainment?.value?.bad ?? 0,
      total: measures?.target_attainment?.value?.total ?? 0,
      coverage: measures?.target_attainment?.coverage ?? null,
      as_of: asOf,
    },
    delivery: {
      open_tasks: deliveryRows[0]?.open_tasks ?? 0,
      overdue_tasks: deliveryRows[0]?.overdue_tasks ?? 0,
      milestones_due_soon: milestoneSoon[0]?.c ?? 0,
      coverage: measures?.task_completion?.coverage ?? null,
      as_of: asOf,
    },
    measures,
    freshness: measures
      ? {
          computed_at: new Date().toISOString(),
          as_of: asOf,
        }
      : undefined,
  };
}
