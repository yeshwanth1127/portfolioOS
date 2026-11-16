const BUSINESS_TZ = process.env.NEXT_PUBLIC_PORTFOLIO_TZ ?? 'Asia/Kolkata';

export function businessTz() {
  return BUSINESS_TZ;
}

/** Today's business date (YYYY-MM-DD) in the portfolio timezone. */
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function formatEventTime(iso, tz, { allDay = false } = {}) {
  if (allDay) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(iso));
  }
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}
