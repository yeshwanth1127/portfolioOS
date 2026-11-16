/** Shared helpers for the Meetings pages. */

export function formatWhen(iso, tz) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz || undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** live | upcoming | past */
export function meetingBucket(m) {
  if (m.status === 'live') return 'live';
  if (m.status === 'ended') return 'past';
  return new Date(m.ends_at) < new Date() ? 'past' : 'upcoming';
}

export function durationLabel(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const MEETING_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * The meeting id in something a person pasted: a full link (any host, with or without
 * ?join=1), a path like /meetings/<id>, or the bare id.
 */
export function meetingIdFromLink(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const path = s.match(/\/meetings\/([0-9a-f-]{36})/i);
  if (path) return path[1].toLowerCase();
  const bare = s.match(/^([0-9a-f-]{36})$/i);
  return bare && MEETING_ID.test(bare[1]) ? bare[1].toLowerCase() : null;
}
