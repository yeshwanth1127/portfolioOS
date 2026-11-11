import { dbQuery } from './db-helpers.js';

const UUID = /^[0-9a-f-]{36}$/i;
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** Org by slug, short name, or name ("comms", "Communications", "communications department"). */
export async function findOrg(client, ref) {
  const r = norm(ref);
  if (!r) return null;
  const { rows } = await dbQuery(
    client,
    `SELECT * FROM organisations
     WHERE lower(slug) = $1 OR lower(short_name) = $1 OR lower(name) = $1
        OR lower(name) LIKE '%' || $1 || '%' OR lower(short_name) LIKE '%' || $1 || '%'
        OR $1 LIKE lower(slug) || '%'
     ORDER BY (lower(slug) = $1) DESC, (lower(short_name) = $1) DESC, (lower(name) = $1) DESC
     LIMIT 2`,
    [r],
  );
  return rows[0] ?? null;
}

/**
 * KPI by id, code ("comms.creatives"), short code ("creatives" + org), or name ("creatives delivered").
 * Scoped to the caller's org unless owner; orgRef narrows the owner's search.
 * Returns { kpi } or { error } (ambiguity lists candidates so the agent can pick).
 */
export async function findKpi(client, membership, ref, orgRef) {
  const r = norm(ref);
  if (!r) return { error: { code: 'invalid', message: 'kpi_code is required' } };
  let orgId = membership.role === 'owner' ? null : membership.org_id;
  if (membership.role === 'owner' && orgRef) orgId = (await findOrg(client, orgRef))?.id ?? null;

  const base = `SELECT k.*, o.slug FROM kpis k JOIN organisations o ON o.id = k.org_id WHERE k.status = 'active'`;
  if (UUID.test(r)) {
    const { rows } = await dbQuery(client, `${base} AND k.id = $1`, [r]);
    return scoped(rows[0], membership);
  }
  // Exact code wins regardless of a (possibly stale) org hint for the owner.
  const exact = await dbQuery(client, `${base} AND lower(k.code) = $1`, [r]);
  if (exact.rows[0]) return scoped(exact.rows[0], membership);

  // Drop an org prefix the model may have invented ("comms.creatives_delivered" → "creatives delivered").
  const bare = r.includes('.') ? r.slice(r.indexOf('.') + 1) : r;
  const words = bare.replace(/[_.]/g, ' ').trim();
  const search = (scopeOrgId) =>
    dbQuery(
      client,
      `${base} AND ($2::uuid IS NULL OR k.org_id = $2)
         AND (lower(k.name) = $1 OR lower(k.code) LIKE '%.' || $3
              OR lower(k.name) LIKE '%' || $1 || '%' OR replace(lower(k.code), '_', ' ') LIKE '%' || $1 || '%')
       ORDER BY (lower(k.name) = $1) DESC, (lower(k.code) LIKE '%.' || $3) DESC, k.code
       LIMIT 6`,
      [words, scopeOrgId, words.replace(/\s+/g, '_')],
    ).then((res) => res.rows);
  let rows = await search(orgId);
  // Owner with a stale org hint: search the whole portfolio before giving up.
  if (!rows.length && membership.role === 'owner' && orgId) rows = await search(null);
  if (!rows.length) {
    return { error: { code: 'not_found', message: `No active KPI matches "${ref}". Call list_kpis for the org to see codes.` } };
  }
  const top = rows.filter((k) => norm(k.name) === words || norm(k.code).endsWith(`.${words.replace(/\s+/g, '_')}`));
  if (rows.length === 1 || top.length === 1) return scoped(top[0] ?? rows[0], membership);
  return {
    error: {
      code: 'ambiguous',
      message: `"${ref}" matches several KPIs; use the exact code.`,
      candidates: rows.map((k) => ({ code: k.code, name: k.name })),
    },
  };
}

function scoped(kpi, membership) {
  if (!kpi) return { error: { code: 'not_found', message: 'KPI not found' } };
  if (membership.role !== 'owner' && kpi.org_id !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'That KPI belongs to another organisation.' } };
  }
  return { kpi };
}
