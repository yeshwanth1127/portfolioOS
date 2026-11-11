import { hashPassword } from '../auth.js';
import { ROLE, assignableRolesFor, isOwner, managesOrg, roleLabel } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { loadOrgFor } from './org-access.js';

export async function addPerson(client, membership, orgSlug, body) {
  const loaded = await loadOrgFor(client, membership, orgSlug);
  if (loaded.error) return loaded;
  if (!managesOrg(membership, loaded.org)) {
    return { error: { code: 'forbidden', message: 'Only the manager or Thyagu can add a person.' } };
  }
  const { full_name, email, title, role, phone_e164, parent_id } = body ?? {};
  if (!full_name || !email) return { error: { code: 'invalid', message: 'Name and email are required.' } };
  const allowedRoles = assignableRolesFor(membership);
  if (role && !allowedRoles.includes(role)) {
    return {
      error: {
        code: 'forbidden',
        message: isOwner(membership)
          ? 'Role must be member, team lead, vice manager, or manager.'
          : 'Managers can add members or a vice manager only.',
      },
    };
  }
  const safeRole = allowedRoles.includes(role) ? role : ROLE.MEMBER;

  const { rows: managers } = await dbQuery(
    client,
    `SELECT id FROM memberships WHERE org_id = $1 AND role = 'manager' AND state <> 'inactive' LIMIT 1`,
    [loaded.org.id],
  );
  const { rows: owners } = await dbQuery(
    client,
    `SELECT id FROM memberships WHERE role = 'owner' LIMIT 1`,
  );
  const ownerMembershipId = owners[0]?.id ?? null;

  if (safeRole === ROLE.MANAGER && managers[0]) {
    return { error: { code: 'invalid', message: 'This organisation already has a manager.' } };
  }

  let parentId = managers[0]?.id ?? null;
  if (safeRole === ROLE.MANAGER) {
    parentId = ownerMembershipId;
  } else if (parent_id) {
    const { rows: parents } = await dbQuery(
      client,
      `SELECT id, role FROM memberships
       WHERE id = $1 AND org_id = $2 AND state <> 'inactive'`,
      [parent_id, loaded.org.id],
    );
    const parent = parents[0];
    if (!parent) {
      return { error: { code: 'invalid', message: 'Reports-to must be someone in this organisation.' } };
    }
    if (safeRole === ROLE.MEMBER && ![ROLE.TEAM_LEAD, ROLE.MANAGER, ROLE.VICE_MANAGER].includes(parent.role)) {
      return {
        error: { code: 'invalid', message: 'A member must report to a team lead, vice manager, or manager.' },
      };
    }
    if (safeRole === ROLE.TEAM_LEAD && ![ROLE.MANAGER, ROLE.VICE_MANAGER].includes(parent.role)) {
      return { error: { code: 'invalid', message: 'A team lead must report to the manager or vice manager.' } };
    }
    if (safeRole === ROLE.VICE_MANAGER && ![ROLE.MANAGER].includes(parent.role)) {
      return { error: { code: 'invalid', message: 'A vice manager must report to the manager.' } };
    }
    parentId = parent.id;
  } else if (safeRole === ROLE.MEMBER) {
    const { rows: tls } = await dbQuery(
      client,
      `SELECT id FROM memberships WHERE org_id = $1 AND role = 'team_lead' AND state <> 'inactive' ORDER BY created_at LIMIT 1`,
      [loaded.org.id],
    );
    parentId = tls[0]?.id ?? parentId;
  } else if (safeRole === ROLE.VICE_MANAGER || safeRole === ROLE.TEAM_LEAD) {
    parentId = managers[0]?.id ?? parentId;
  }

  const { rows: users } = await dbQuery(
    client,
    `INSERT INTO users (full_name, email, password_hash, is_named, phone_e164)
     VALUES ($1,$2,$3,true,$4) RETURNING id`,
    [full_name, email, hashPassword('password123'), phone_e164 || null],
  );
  const { rows: created } = await dbQuery(
    client,
    `INSERT INTO memberships (user_id, org_id, role, title, parent_id, state)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
    [users[0].id, loaded.org.id, safeRole, title || roleLabel(safeRole), parentId],
  );
  return { id: created[0].id, ok: true };
}

export async function updatePerson(client, membership, personId, body) {
  const { rows } = await dbQuery(
    client,
    `SELECT m.*, o.slug FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.id = $1`,
    [personId],
  );
  const person = rows[0];
  if (!person) return { error: { code: 'not_found', message: 'Person not found' } };
  const loaded = await loadOrgFor(client, membership, person.slug);
  if (loaded.error) return loaded;
  if (!managesOrg(membership, loaded.org)) {
    return { error: { code: 'forbidden', message: 'Only the manager or Thyagu can edit a person.' } };
  }
  const { full_name, title, phone_e164, role, parent_id } = body ?? {};
  if (phone_e164 !== undefined) {
    await dbQuery(client, `UPDATE users SET phone_e164 = $1 WHERE id = $2`, [
      phone_e164 || null,
      person.user_id,
    ]);
  }
  if (full_name) {
    await dbQuery(client, `UPDATE users SET full_name = $1, is_named = true WHERE id = $2`, [
      full_name,
      person.user_id,
    ]);
    await dbQuery(client, `UPDATE memberships SET state = 'active' WHERE id = $1`, [person.id]);
  }
  if (title) await dbQuery(client, `UPDATE memberships SET title = $1 WHERE id = $2`, [title, person.id]);
  if (role !== undefined) {
    if (person.role === ROLE.MANAGER && !isOwner(membership)) {
      return { error: { code: 'invalid', message: 'Cannot change the organisation manager role here.' } };
    }
    const allowedRoles = assignableRolesFor(membership);
    if (!allowedRoles.includes(role)) {
      return {
        error: {
          code: 'forbidden',
          message: isOwner(membership)
            ? 'Role must be member, team lead, vice manager, or manager.'
            : 'Managers can set member or vice manager only.',
        },
      };
    }
    if (role === ROLE.MANAGER && person.role !== ROLE.MANAGER) {
      const { rows: existing } = await dbQuery(
        client,
        `SELECT id FROM memberships WHERE org_id = $1 AND role = 'manager' AND state <> 'inactive' AND id <> $2 LIMIT 1`,
        [loaded.org.id, person.id],
      );
      if (existing[0]) {
        return { error: { code: 'invalid', message: 'This organisation already has a manager.' } };
      }
    }
    await dbQuery(client, `UPDATE memberships SET role = $1 WHERE id = $2`, [role, person.id]);
  }
  if (parent_id !== undefined) {
    if (parent_id) {
      const { rows: parents } = await dbQuery(
        client,
        `SELECT id FROM memberships WHERE id = $1 AND org_id = $2 AND state <> 'inactive'`,
        [parent_id, loaded.org.id],
      );
      if (!parents[0]) {
        return { error: { code: 'invalid', message: 'Reports-to must be someone in this organisation.' } };
      }
    }
    await dbQuery(client, `UPDATE memberships SET parent_id = $1 WHERE id = $2`, [
      parent_id || null,
      person.id,
    ]);
  }
  return { ok: true };
}

export async function removePerson(client, membership, personId) {
  const { rows } = await dbQuery(
    client,
    `SELECT m.*, o.slug FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.id = $1`,
    [personId],
  );
  const person = rows[0];
  if (!person) return { error: { code: 'not_found', message: 'Person not found' } };
  const loaded = await loadOrgFor(client, membership, person.slug);
  if (loaded.error) return loaded;
  if (!managesOrg(membership, loaded.org)) {
    return { error: { code: 'forbidden', message: 'Only the manager or Thyagu can remove a person.' } };
  }
  if (person.id === membership.id) {
    return { error: { code: 'invalid', message: 'You cannot remove yourself.' } };
  }
  await dbQuery(client, `UPDATE memberships SET state = 'inactive' WHERE id = $1`, [person.id]);
  return { ok: true };
}
