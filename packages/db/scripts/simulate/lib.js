/** Shared helpers for the workspace simulator: randomness, dates, batched inserts. */
import crypto from 'crypto';

export const uuid = () => crypto.randomUUID();

/** Deterministic random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p) => next() < p,
    between: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    normal: (mean = 0, sd = 1) => {
      const u = Math.max(next(), 1e-9);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday
export const todayIn = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** UTC instant for local wall-clock `minutes` after midnight on `iso` in `tz`. */
export function at(tz, iso, minutes) {
  const guess = new Date(`${iso}T00:00:00Z`).getTime() + Math.round(minutes) * 60000;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess - (shown - guess));
}

/** Last Monday–Friday of the month (when monthly numbers are entered). */
export function isLastWeekdayOfMonth(iso) {
  if (dow(iso) === 0 || dow(iso) === 6) return false;
  for (let d = addDays(iso, 1); d.slice(5, 7) === iso.slice(5, 7); d = addDays(d, 1)) {
    if (dow(d) !== 0 && dow(d) !== 6) return false;
  }
  return true;
}

export function isLastWorkdayOfMonth(iso) {
  for (let d = addDays(iso, 1); d.slice(5, 7) === iso.slice(5, 7); d = addDays(d, 1)) {
    if (dow(d) !== 0) return false;
  }
  return true;
}

/** Insert many rows in chunks. `rows` are arrays in `cols` order. */
export async function insertRows(q, table, cols, rows, { onConflict = '' } = {}) {
  const per = Math.max(1, Math.floor(30000 / cols.length));
  let n = 0;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params = [];
    const values = chunk.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(',')})`);
    const res = await q(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ${onConflict}`, params);
    n += res.rowCount;
  }
  return n;
}

export const CAD_RANK = { 'Every day': 0, 'Every week': 1, 'Every month': 2, 'Every quarter': 3 };
