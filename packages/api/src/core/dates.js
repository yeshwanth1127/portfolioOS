/**
 * Business dates. A "day" is a calendar date in the business timezone, never a UTC date:
 * between 00:00 and 05:30 IST the UTC date is still yesterday.
 * Phase 2 passes the workspace timezone; until then everything is Asia/Kolkata.
 */
export const DEFAULT_TZ = process.env.PORTFOLIO_TZ ?? 'Asia/Kolkata';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' for the given instant in the given timezone. */
export function dateIn(tz = DEFAULT_TZ, at = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Today's business date. */
export function todayIn(tz = DEFAULT_TZ) {
  return dateIn(tz, new Date());
}

/** Add whole days to a 'YYYY-MM-DD' date. */
export function addDays(isoDate, days) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); // date arithmetic only
}

export function isIsoDate(value) {
  return ISO_DATE.test(String(value ?? '').trim());
}

/** The given date if it is a valid 'YYYY-MM-DD', otherwise today's business date. */
export function dateOrToday(value, tz = DEFAULT_TZ) {
  return isIsoDate(value) ? String(value).trim() : todayIn(tz);
}
