import crypto from 'crypto';
import { withSession } from '../db.js';
import { hashPassword } from '../core/passwords.js';
import { can } from '../core/permissions/can.js';
import { permissionDenied } from '../core/permissions/permission-denied.js';
import { ROLE, assignableRolesFor, roleLabel } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import {
  toAssignmentRole,
  toMembershipRole,
  upsertAssignmentFromMembership,
} from './assignment-sync.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function loadUnit(client, unitId) {
  const { rows } = await dbQuery(
    client,
    `SELECT u.*, o.id AS org_id, o.slug
     FROM units u
     LEFT JOIN organisations o ON o.id = u.legacy_org_id
     WHERE u.id = $1`,
    [unitId],
  );
  return rows[0] ?? null;
}

function assignableAssignmentRoles(membership) {
  return assignableRolesFor(membership).map(toAssignmentRole).filter(Boolean);
}

export async function createInvitation(client, membership, body) {
  const { email, unit_id, role, title } = body ?? {};
  if (!email || !unit_id || !role) {
    return { error: { code: 'invalid', message: 'email, unit_id, and role are required.' } };
  }
  const unit = await loadUnit(client, unit_id);
  if (!unit) return { error: { code: 'not_found', message: 'Unit not found' } };
  if (!unit.legacy_org_id) {
    return { error: { code: 'invalid', message: 'Unit is not linked to an organisation.' } };
  }
  const org = { id: unit.legacy_org_id, slug: unit.slug };
  if (!can(membership, 'invitation.create', { org })) {
    return permissionDenied(membership, 'invitation.create');
  }
  const assignmentRole = toAssignmentRole(role);
  if (!assignmentRole || !assignableAssignmentRoles(membership).includes(assignmentRole)) {
    return {
      error: {
        code: 'forbidden',
        message: membership.role === ROLE.OWNER
          ? 'Role must be contributor, team lead, unit deputy, or unit manager.'
          : 'Managers can invite contributors or a unit deputy only.',
      },
    };
  }
  if (assignmentRole === 'unit_manager') {
    const { rows: managers } = await dbQuery(
      client,
      `SELECT id FROM memberships WHERE org_id = $1 AND role = 'manager' AND state <> 'inactive' LIMIT 1`,
      [unit.legacy_org_id],
    );
    if (managers[0]) {
      return { error: { code: 'invalid', message: 'This organisation already has a manager.' } };
    }
  }
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await dbQuery(
    client,
    `INSERT INTO invitations (workspace_id, email, role, unit_id, token_hash, expires_at)
     VALUES ($1, lower($2), $3, $4, $5, $6)
     RETURNING id, email, role, unit_id, expires_at, created_at`,
    [membership.workspace_id, email, assignmentRole, unit_id, hashToken(token), expiresAt],
  );
  return {
    invitation: { ...rows[0], title: title ?? null },
    token,
    ok: true,
  };
}

export async function listInvitations(client, membership) {
  let clause = '';
  const params = [];
  if (membership.role !== ROLE.OWNER) {
    clause = `AND un.legacy_org_id = $1`;
    params.push(membership.org_id);
  }
  const { rows } = await dbQuery(
    client,
    `SELECT i.id, i.email, i.role, i.unit_id, i.expires_at, i.accepted_at, i.created_at,
            un.name AS unit_name, un.legacy_org_id
     FROM invitations i
     JOIN units un ON un.id = i.unit_id
     WHERE i.accepted_at IS NULL ${clause}
     ORDER BY i.created_at DESC`,
    params,
  );
  return { invitations: rows };
}

/**
 * Public accept: body must include workspace_id and token from create response.
 */
export async function acceptInvitation(invitationId, body) {
  const { workspace_id, token, full_name, password, title } = body ?? {};
  if (!workspace_id || !token || !full_name) {
    return { error: { code: 'invalid', message: 'workspace_id, token, and full_name are required.' } };
  }
  if (password && String(password).length < 8) {
    return { error: { code: 'invalid', message: 'A password needs at least 8 characters.' } };
  }
  const systemActor = {
    id: '00000000-0000-0000-0000-000000000000',
    role: 'system',
    org_id: null,
    workspace_id,
  };
  return withSession(systemActor, async (client) => {
    const { rows } = await dbQuery(
      client,
      `SELECT i.*, un.legacy_org_id AS org_id
       FROM invitations i
       JOIN units un ON un.id = i.unit_id
       WHERE i.id = $1 AND i.workspace_id = $2`,
      [invitationId, workspace_id],
    );
    const invite = rows[0];
    if (!invite) return { error: { code: 'not_found', message: 'Invitation not found' } };
    if (invite.accepted_at) return { error: { code: 'conflict', message: 'Invitation already accepted.' } };
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return { error: { code: 'invalid', message: 'Invitation has expired.' } };
    }
    if (!invite.token_hash || hashToken(token) !== invite.token_hash) {
      return { error: { code: 'forbidden', message: 'Invalid invitation token.' } };
    }
    const { rows: existingUsers } = await dbQuery(client, `SELECT id FROM users WHERE lower(email) = lower($1)`, [
      invite.email,
    ]);
    if (existingUsers[0]) {
      return { error: { code: 'conflict', message: 'An account with this email already exists.' } };
    }
    const membershipRole = toMembershipRole(invite.role);
    const { rows: managers } = await dbQuery(
      client,
      `SELECT id FROM memberships WHERE org_id = $1 AND role = 'manager' AND state <> 'inactive' LIMIT 1`,
      [invite.org_id],
    );
    let parentId = managers[0]?.id ?? null;
    if (membershipRole === ROLE.MANAGER) {
      const { rows: owners } = await dbQuery(client, `SELECT id FROM memberships WHERE role = 'owner' LIMIT 1`);
      parentId = owners[0]?.id ?? null;
    } else if (membershipRole === ROLE.MEMBER) {
      const { rows: tls } = await dbQuery(
        client,
        `SELECT id FROM memberships WHERE org_id = $1 AND role = 'team_lead' AND state <> 'inactive' ORDER BY created_at LIMIT 1`,
        [invite.org_id],
      );
      parentId = tls[0]?.id ?? parentId;
    } else if (membershipRole === ROLE.VICE_MANAGER || membershipRole === ROLE.TEAM_LEAD) {
      parentId = managers[0]?.id ?? parentId;
    }
    const safeTitle = title || roleLabel(membershipRole);
    const { rows: users } = await dbQuery(
      client,
      `INSERT INTO users (full_name, email, password_hash, is_named, phone_e164)
       VALUES ($1, lower($2), $3, true, $4) RETURNING id`,
      [full_name, invite.email, password ? await hashPassword(password) : null, invite.phone_e164],
    );
    await dbQuery(
      client,
      `INSERT INTO workspace_members (workspace_id, user_id, workspace_role)
       VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [workspace_id, users[0].id],
    );
    const { rows: created } = await dbQuery(
      client,
      `INSERT INTO memberships (user_id, org_id, role, title, parent_id, state, workspace_id)
       VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
      [users[0].id, invite.org_id, membershipRole, safeTitle, parentId, workspace_id],
    );
    await upsertAssignmentFromMembership(client, created[0]);
    await dbQuery(client, `UPDATE invitations SET accepted_at = now() WHERE id = $1`, [invite.id]);
    return {
      ok: true,
      id: created[0].id,
      can_sign_in: Boolean(password),
    };
  });
}
