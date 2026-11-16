import crypto from 'crypto';
import { isOwner } from '../../roles.js';

const dryRunCache = new Map();

function parseCsv(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim());
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = cols[i] ?? '';
    });
    return obj;
  });
  return { header, rows };
}

function section(text, name) {
  const re = new RegExp(`^#\\s*${name}\\s*$`, 'im');
  const match = re.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^#\s*\w+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

export async function importCsvDryRun(client, membership, body) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Onboarding is for the workspace owner.' } };
  }
  const raw = String(body?.csv ?? '');
  if (!raw.trim()) return { error: { code: 'invalid', message: 'csv body required' } };

  const people = parseCsv(section(raw, 'people'));
  const units = parseCsv(section(raw, 'units'));
  const kpis = parseCsv(section(raw, 'kpis'));

  const errors = [];
  for (const [i, row] of people.rows.entries()) {
    if (!row.email || !row.full_name) errors.push({ section: 'people', line: i + 2, message: 'email and full_name required' });
    if (row.role && !['owner', 'manager', 'vice_manager', 'team_lead', 'member'].includes(row.role)) {
      errors.push({ section: 'people', line: i + 2, message: `invalid role ${row.role}` });
    }
  }
  for (const [i, row] of units.rows.entries()) {
    if (!row.name || !row.type) errors.push({ section: 'units', line: i + 2, message: 'name and type required' });
    if (row.type && !['organisation', 'branch', 'department', 'team'].includes(row.type)) {
      errors.push({ section: 'units', line: i + 2, message: `invalid type ${row.type}` });
    }
  }
  for (const [i, row] of kpis.rows.entries()) {
    if (!row.code || !row.name) errors.push({ section: 'kpis', line: i + 2, message: 'code and name required' });
  }

  if (errors.length) {
    return {
      dry_run_token: null,
      summary: { people: people.rows.length, units: units.rows.length, kpis: kpis.rows.length, errors: errors.length },
      errors,
      valid: false,
    };
  }
  const payload = { people: people.rows, units: units.rows, kpis: kpis.rows };
  const token = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ws: membership.workspace_id, payload, salt: crypto.randomBytes(8).toString('hex') }))
    .digest('hex');

  dryRunCache.set(token, { workspaceId: membership.workspace_id, payload, at: Date.now() });

  return {
    dry_run_token: token,
    summary: {
      people: people.rows.length,
      units: units.rows.length,
      kpis: kpis.rows.length,
      errors: errors.length,
    },
    errors,
    valid: errors.length === 0,
  };
}

export async function applyOnboarding(client, membership, body) {
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Onboarding is for the workspace owner.' } };
  }
  const token = String(body?.dry_run_token ?? '');
  const cached = dryRunCache.get(token);
  if (!cached || cached.workspaceId !== membership.workspace_id) {
    return { error: { code: 'invalid', message: 'dry_run_token unknown or expired' } };
  }
  if ((cached.payload.people?.length === 0 && cached.payload.units?.length === 0 && cached.payload.kpis?.length === 0)) {
    return { error: { code: 'invalid', message: 'Nothing to apply.' } };
  }
  dryRunCache.delete(token);

  const applied = { units: 0, people: 0, kpis: 0 };

  const unitIds = new Map();
  const { rows: legacyUnits } = await client.query(
    `SELECT o.slug, u.id AS unit_id
     FROM organisations o
     JOIN units u ON u.legacy_org_id = o.id AND u.workspace_id = o.workspace_id`,
  );
  for (const o of legacyUnits) unitIds.set(o.slug, o.unit_id);

  for (const row of cached.payload.units) {
    const parentKey = row.parent_slug || row.parent_name;
    const parentId = parentKey ? unitIds.get(parentKey) : null;
    const { rows } = await client.query(
      `INSERT INTO units (parent_id, type, name, short_name)
       VALUES ($1, $2, $3, coalesce(nullif($4,''), left($3, 12)))
       RETURNING id`,
      [parentId, row.type, row.name, row.short_name ?? ''],
    );
    unitIds.set(row.name, rows[0].id);
    if (row.slug) unitIds.set(row.slug, rows[0].id);
    applied.units += 1;
  }

  for (const row of cached.payload.people) {
    const { rows: existing } = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [row.email]);
    let userId = existing[0]?.id;
    if (!userId) {
      const ins = await client.query(
        `INSERT INTO users (full_name, email) VALUES ($1, $2) RETURNING id`,
        [row.full_name, row.email],
      );
      userId = ins.rows[0].id;
    }
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, workspace_role)
       VALUES ($1, $2, 'member') ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [membership.workspace_id, userId],
    );
    const { rows: existingMember } = await client.query(
      `SELECT id FROM memberships WHERE user_id = $1 AND workspace_id = $2 AND state <> 'inactive'`,
      [userId, membership.workspace_id],
    );
    if (!existingMember.length) {
      await client.query(
        `INSERT INTO memberships (user_id, org_id, role, title, workspace_id)
         VALUES ($1, (SELECT id FROM organisations WHERE slug = $2 LIMIT 1), $3, $4, $5)`,
        [userId, row.org_slug ?? 'alpha', row.role ?? 'member', row.title ?? row.role, membership.workspace_id],
      );
    }
    applied.people += 1;
  }

  for (const row of cached.payload.kpis) {
    await client.query(
      `INSERT INTO kpis (org_id, code, name, unit, owned_at_level, how_often, rollup_method, source_tag, rationale)
       SELECT o.id, $1, $2, coalesce(nullif($3,''), 'count'), 'member', 'Every day', 'sum', 'derived', 'onboarding'
       FROM organisations o WHERE o.slug = $4
         AND NOT EXISTS (SELECT 1 FROM kpis k WHERE k.org_id = o.id AND k.code = $1)`,
      [row.code, row.name, row.unit ?? '', row.org_slug ?? 'alpha'],
    );
    applied.kpis += 1;
  }

  return { applied, dry_run_token: token };
}
