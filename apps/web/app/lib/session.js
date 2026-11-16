export const SESSION_KEY = 'portfolio-os-session';
export const ORG_KEY = 'portfolio-os-org';
export const ORG_CHANGE_EVENT = 'portfolio-org-change';
export const ORGS_UPDATED_EVENT = 'portfolio-orgs-updated';

export function readStoredSession() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStoredSession(next) {
  if (typeof window === 'undefined') return;
  if (next?.token) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
}

export function readStoredOrgSlug() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ORG_KEY) || readStoredSession()?.membership?.org_slug || null;
}

export function writeStoredOrgSlug(slug) {
  if (typeof window === 'undefined') return;
  if (slug) localStorage.setItem(ORG_KEY, slug);
  else localStorage.removeItem(ORG_KEY);
}
