import { dbQuery } from './db-helpers.js';
import { findOrg } from './lookup.js';

export async function loadOrgFor(client, membership, slug) {
  const org = await findOrg(client, slug);
  if (!org) return { error: { code: 'not_found', message: 'Not found' } };
  if (membership.role !== 'owner' && org.id !== membership.org_id) {
    return { error: { code: 'forbidden', message: 'Forbidden' } };
  }
  return { org };
}

export async function resolveOrgId(client, membership, orgSlug) {
  if (membership.role === 'owner') {
    if (!orgSlug) return null;
    return (await findOrg(client, orgSlug))?.id ?? null;
  }
  return membership.org_id;
}

export async function orgIdFromSlug(client, slug) {
  return (await findOrg(client, slug))?.id ?? null;
}
