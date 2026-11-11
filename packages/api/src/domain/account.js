import { loadMembership } from '../auth.js';
import { dbQuery } from './db-helpers.js';

export async function showMe(membershipId) {
  const membership = await loadMembership(membershipId);
  if (!membership) return { error: { code: 'not_found', message: 'Membership not found' } };
  return { membership };
}

export async function updateMe(client, membership, body) {
  const { phone_e164, full_name } = body ?? {};
  const userId = membership.user_id;
  if (phone_e164 !== undefined) {
    await dbQuery(client, `UPDATE users SET phone_e164 = $1 WHERE id = $2`, [
      phone_e164 || null,
      userId,
    ]);
  }
  if (full_name !== undefined) {
    const name = String(full_name || '').trim();
    if (!name) return { error: { code: 'invalid', message: 'Name is required.' } };
    await dbQuery(client, `UPDATE users SET full_name = $1, is_named = true WHERE id = $2`, [
      name,
      userId,
    ]);
    await dbQuery(
      client,
      `UPDATE memberships SET state = 'active' WHERE id = $1 AND state = 'pending_name'`,
      [membership.id],
    );
  }
  const updated = await loadMembership(membership.id);
  return { membership: updated };
}
