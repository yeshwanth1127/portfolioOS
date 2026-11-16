/** Display helpers for generated reports (same formats the API declares per column). */

export function formatValue(value, format) {
  if (value == null || value === '' || Number.isNaN(value)) return '—';
  switch (format) {
    case 'pct':
      return `${Math.round(Number(value) * 100)}%`;
    case 'int':
    case 'num':
      return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 });
    case 'hours':
      return `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 })} h`;
    case 'date':
      return shortDate(value);
    default:
      return String(value);
  }
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function periodLabel(from, to) {
  if (!from) return '';
  if (from === to) return new Date(`${from}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const a = new Date(`${from}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  const b = new Date(`${to}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${a} – ${b}`;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Period presets relative to the workspace's today (YYYY-MM-DD). Weeks start on Monday. */
export function periodPresets(today) {
  if (!today) return [];
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = addDays(today, -dow);
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = addDays(monthStart, -1);
  const prevMonthStart = `${prevMonthEnd.slice(0, 7)}-01`;
  return [
    { id: 'today', label: 'Today', from: today, to: today },
    { id: 'yesterday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { id: 'this_week', label: 'This week', from: weekStart, to: today },
    { id: 'last_week', label: 'Last week', from: addDays(weekStart, -7), to: addDays(weekStart, -1) },
    { id: 'this_month', label: 'This month', from: monthStart, to: today },
    { id: 'last_month', label: 'Last month', from: prevMonthStart, to: prevMonthEnd },
    { id: 'custom', label: 'Custom' },
  ];
}

export const STATUS_TEXT = {
  queued: 'Starting',
  running: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
};

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
