import { pacedGoal, periodWindow, rollupValues } from './cadence.js';
/** Amber starts at this fraction of the goal (higher_is_better). */
export const AMBER_RATIO = 0.8;

export const BANDS_NOTE =
  'green at or above goal, amber from 80% of goal, red below 80%. Week/month/quarter sums are judged on pace (goal x days elapsed / days in period).';

/** Derive stored green_at / amber_at from a goal (for DB CHECK; scoring uses target). */
export function deriveBands(target, direction = 'higher_is_better') {
  if (target == null || target === '' || !Number.isFinite(Number(target))) {
    return { green_at: null, amber_at: null };
  }
  const goal = Number(target);
  if (direction === 'lower_is_better') {
    return {
      green_at: goal,
      amber_at: Math.round((goal / AMBER_RATIO) * 100) / 100,
    };
  }
  return {
    green_at: goal,
    amber_at: Math.round(goal * AMBER_RATIO * 100) / 100,
  };
}

export function computeRag(kpi, value) {
  if (kpi.target == null || kpi.unmeasured) return 'unscored';
  if (value == null) return 'unscored';
  const v = Number(value);
  const goal = Number(kpi.target);
  const { amber_at: amber } = deriveBands(goal, kpi.direction);
  if (kpi.direction === 'higher_is_better') {
    if (v >= goal) return 'green';
    if (v >= amber) return 'amber';
    return 'red';
  }
  if (v <= goal) return 'green';
  if (v <= amber) return 'amber';
  return 'red';
}

/** Score every tracked cadence of every active KPI in an org, as of `periodDate`. */
export async function scoreOrgDay(client, orgId, periodDate) {
  const { rows: kpis } = await client.query(
    `SELECT k.id, k.target, k.direction, k.unmeasured, k.unit, k.rollup_method, k.how_often,
            COALESCE(json_agg(json_build_object('how_often', g.how_often, 'target', g.target))
                     FILTER (WHERE g.kpi_id IS NOT NULL), '[]') AS goals
     FROM kpis k LEFT JOIN kpi_goals g ON g.kpi_id = k.id
     WHERE k.org_id = $1 AND k.status = 'active'
     GROUP BY k.id`,
    [orgId],
  );
  for (const kpi of kpis) {
    const goals = kpi.goals.length ? kpi.goals : [{ how_often: kpi.how_often, target: kpi.target }];
    for (const g of goals) {
      const win = periodWindow(g.how_often, periodDate);
      // Highest-level accepted submission per day, within the period up to the as-of day.
      const { rows: daily } = await client.query(
        `SELECT DISTINCT ON (period_date) period_date, value
         FROM submissions
         WHERE kpi_id = $1 AND period_date BETWEEN $2 AND $3
           AND state IN ('validated','locked','amended') AND value IS NOT NULL
         ORDER BY period_date, CASE level
           WHEN 'owner' THEN 5 WHEN 'manager' THEN 4 WHEN 'vice_manager' THEN 3
           WHEN 'team_lead' THEN 2 ELSE 1 END DESC`,
        [kpi.id, win.start, periodDate],
      );
      const value = rollupValues(kpi, daily);
      const goal = g.target == null ? null : Number(g.target);
      const paced = pacedGoal(kpi, g.how_often, goal, periodDate);
      const rag = computeRag({ ...kpi, target: paced }, value);
      let variance_pct = null;
      if (paced != null && value != null && paced !== 0) {
        variance_pct = Math.round(((value - paced) / paced) * 10000) / 100;
      }
      await client.query(
        `INSERT INTO scores (org_id, kpi_id, period_date, how_often, value, rag, variance_pct, goal, paced_goal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (kpi_id, period_date, how_often) DO UPDATE SET
           value = EXCLUDED.value, rag = EXCLUDED.rag, variance_pct = EXCLUDED.variance_pct,
           goal = EXCLUDED.goal, paced_goal = EXCLUDED.paced_goal, scored_at = now()`,
        [orgId, kpi.id, periodDate, g.how_often, value, rag, variance_pct, goal, paced],
      );
    }
  }
}
