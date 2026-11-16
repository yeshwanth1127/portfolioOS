/*
 * Who a report may cover.
 *   owner          whole workspace, any organisation, any person
 *   manager / vice their organisation, anyone in it, themselves
 *   team lead      their team (everyone under them), anyone in it, themselves
 *   member         themselves
 * Row-level security still applies to every query underneath; this decides what may be asked.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });

const ORG_ROLES = new Set(['manager', 'vice_manager']);

async function nameOf(client, membershipId) {
  const { rows } = await client.query(
    `SELECT u.full_name, m.title, o.short_name AS org
     FROM memberships m JOIN users u ON u.id = m.user_id
     LEFT JOIN organisations o ON o.id = m.org_id
     WHERE m.id = $1`,
    [membershipId],
  );
  return rows[0] ?? null;
}

/** Active memberships under `rootId` (inclusive), following memberships.parent_id. */
async function subtree(client, rootId) {
  const { rows } = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM memberships WHERE id = $1
       UNION
       SELECT m.id FROM memberships m JOIN tree t ON m.parent_id = t.id
     )
     SELECT m.id FROM memberships m JOIN tree t ON t.id = m.id WHERE m.state <> 'inactive'`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

async function orgPeople(client, orgId) {
  const { rows } = await client.query(
    `SELECT id FROM memberships WHERE org_id = $1 AND state <> 'inactive'`,
    [orgId],
  );
  return rows.map((r) => r.id);
}

async function workspacePeople(client) {
  const { rows } = await client.query(`SELECT id FROM memberships WHERE state <> 'inactive'`);
  return rows.map((r) => r.id);
}

/** People this caller may report on (ids), for validating a `person` scope. */
async function reachablePeople(client, membership) {
  if (membership.role === 'owner') return workspacePeople(client);
  if (ORG_ROLES.has(membership.role) && membership.org_id) return orgPeople(client, membership.org_id);
  if (membership.role === 'team_lead') return subtree(client, membership.id);
  return [membership.id];
}

/** Scope choices for the report picker. */
export async function scopeOptions(client, membership) {
  const options = [];
  if (membership.role === 'owner') {
    options.push({ kind: 'workspace', ref: null, label: membership.workspace_name || 'Whole workspace' });
    const { rows } = await client.query(
      `SELECT id, short_name FROM organisations WHERE status = 'active' ORDER BY short_name`,
    );
    for (const o of rows) options.push({ kind: 'org', ref: o.id, label: o.short_name });
  } else if (ORG_ROLES.has(membership.role) && membership.org_id) {
    options.push({ kind: 'org', ref: membership.org_id, label: membership.org_short_name || 'My organisation' });
  } else if (membership.role === 'team_lead') {
    options.push({ kind: 'team', ref: membership.id, label: 'My team' });
  }
  options.push({ kind: 'me', ref: membership.id, label: 'Just me' });

  const people = [];
  if (membership.role !== 'member') {
    const ids = (await reachablePeople(client, membership)).filter((id) => id !== membership.id);
    if (ids.length) {
      const { rows } = await client.query(
        `SELECT m.id, u.full_name, o.short_name AS org
         FROM memberships m JOIN users u ON u.id = m.user_id
         LEFT JOIN organisations o ON o.id = m.org_id
         WHERE m.id = ANY($1::uuid[])
         ORDER BY o.short_name NULLS FIRST, u.full_name`,
        [ids],
      );
      for (const p of rows) people.push({ kind: 'person', ref: p.id, label: p.full_name, group: p.org ?? '' });
    }
  }
  return { scopes: options, people };
}

/**
 * Validate a requested scope and expand it.
 * @returns {{ kind, ref, label, orgId, people: string[] } | { error }}
 */
export async function resolveScope(client, membership, input = {}) {
  const kind = String(input.scope_kind ?? '').trim() || defaultKind(membership);
  const ref = input.scope_ref == null || input.scope_ref === '' ? null : String(input.scope_ref);
  if (ref && !UUID.test(ref)) return err('invalid', 'Unknown scope.');

  if (kind === 'me') {
    const me = await nameOf(client, membership.id);
    return { kind, ref: membership.id, label: me?.full_name ?? 'Me', orgId: null, people: [membership.id] };
  }

  if (kind === 'workspace') {
    if (membership.role !== 'owner') return err('forbidden', 'Only the owner can report on the whole workspace.');
    return {
      kind,
      ref: null,
      label: membership.workspace_name || 'Whole workspace',
      orgId: null,
      people: await workspacePeople(client),
    };
  }

  if (kind === 'org') {
    const orgId = membership.role === 'owner' ? ref : membership.org_id;
    if (!orgId) return err('invalid', 'Choose an organisation.');
    if (membership.role !== 'owner' && !(ORG_ROLES.has(membership.role) && (!ref || ref === membership.org_id))) {
      return err('forbidden', 'You can report on your own organisation only.');
    }
    const { rows } = await client.query(`SELECT short_name FROM organisations WHERE id = $1`, [orgId]);
    if (!rows[0]) return err('not_found', 'Organisation not found.');
    return { kind, ref: orgId, label: rows[0].short_name, orgId, people: await orgPeople(client, orgId) };
  }

  if (kind === 'team') {
    if (membership.role === 'member') return err('forbidden', 'You have no team to report on.');
    const root = membership.role === 'team_lead' || !ref ? membership.id : ref;
    if (root !== membership.id) {
      const allowed = await reachablePeople(client, membership);
      if (!allowed.includes(root)) return err('forbidden', 'That team is outside your reach.');
    }
    const lead = await nameOf(client, root);
    return {
      kind,
      ref: root,
      label: root === membership.id ? 'My team' : `${lead?.full_name ?? 'Team'}'s team`,
      orgId: null,
      people: await subtree(client, root),
    };
  }

  if (kind === 'person') {
    if (!ref) return err('invalid', 'Choose a person.');
    const allowed = await reachablePeople(client, membership);
    if (!allowed.includes(ref)) return err('forbidden', 'You cannot report on that person.');
    const p = await nameOf(client, ref);
    if (!p) return err('not_found', 'Person not found.');
    return { kind, ref, label: p.full_name, orgId: null, people: [ref] };
  }

  return err('invalid', 'Unknown scope.');
}

export function defaultKind(membership) {
  if (membership.role === 'owner') return 'workspace';
  if (ORG_ROLES.has(membership.role) && membership.org_id) return 'org';
  if (membership.role === 'team_lead') return 'team';
  return 'me';
}
