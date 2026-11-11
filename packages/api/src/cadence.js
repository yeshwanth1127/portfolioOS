/** Cadence helpers: ordering, period windows (calendar, Mon-start weeks), rollup. */

export const CADENCES = ['Every day', 'Every week', 'Every month', 'Every quarter'];
export const CADENCE_SHORT = {
  'Every day': 'day',
  'Every week': 'week',
  'Every month': 'month',
  'Every quarter': 'quarter',
};

export function cadenceRank(c) {
  const i = CADENCES.indexOf(c);
  return i === -1 ? 0 : i;
}

/** Most frequent cadence in a list (numbers are submitted at this cadence). */
export function baseCadence(list) {
  const valid = (list ?? []).filter((c) => CADENCES.includes(c));
  if (!valid.length) return 'Every day';
  return valid.sort((a, b) => cadenceRank(a) - cadenceRank(b))[0];
}

function utc(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function iso(date) {
  return date.toISOString().slice(0, 10);
}

/** { start, end, elapsedDays, totalDays } for the period of `cadence` containing `asOf`. */
export function periodWindow(cadence, asOf) {
  const d = utc(asOf);
  let start;
  let end;
  if (cadence === 'Every week') {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    start = new Date(d);
    start.setUTCDate(d.getUTCDate() - dow);
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (cadence === 'Every month') {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  } else if (cadence === 'Every quarter') {
    const q = Math.floor(d.getUTCMonth() / 3) * 3;
    start = new Date(Date.UTC(d.getUTCFullYear(), q, 1));
    end = new Date(Date.UTC(d.getUTCFullYear(), q + 3, 0));
  } else {
    start = d;
    end = d;
  }
  const day = 86400000;
  return {
    start: iso(start),
    end: iso(end),
    elapsedDays: Math.round((d - start) / day) + 1,
    totalDays: Math.round((end - start) / day) + 1,
  };
}

/** sum | average | latest. `manual` → average for %, otherwise sum. */
export function effectiveRollup(kpi) {
  const r = kpi.rollup_method;
  if (r === 'sum' || r === 'average' || r === 'latest') return r;
  return kpi.unit === '%' ? 'average' : 'sum';
}

/** values: [{ period_date, value }] ordered by period_date asc. */
export function rollupValues(kpi, values) {
  const nums = values.map((v) => Number(v.value)).filter(Number.isFinite);
  if (!nums.length) return null;
  const mode = effectiveRollup(kpi);
  if (mode === 'latest') return nums[nums.length - 1];
  const sum = nums.reduce((a, b) => a + b, 0);
  if (mode === 'average') return Math.round((sum / nums.length) * 100) / 100;
  return Math.round(sum * 100) / 100;
}

/**
 * Goal to compare against part-way through a period. Sums are judged on pace
 * (goal × elapsed / total days); averages and latest values compare to the full goal.
 */
export function pacedGoal(kpi, cadence, goal, asOf) {
  if (goal == null) return null;
  const g = Number(goal);
  // The entered number already is the figure for its own cadence; pace only rolled-up periods.
  if (cadence === 'Every day' || cadence === kpi.how_often || effectiveRollup(kpi) !== 'sum') return g;
  const w = periodWindow(cadence, asOf);
  return Math.round(((g * w.elapsedDays) / w.totalDays) * 100) / 100;
}
