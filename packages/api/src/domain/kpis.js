import { normalizeHowOften, HOW_OFTEN_DEFAULT } from '../how-often.js';
import { CADENCES, baseCadence, cadenceRank } from '../cadence.js';
import { BANDS_NOTE, deriveBands } from '../scoring.js';
import { ROLE, isOwner, managesOrg } from '../roles.js';
import { dbQuery } from './db-helpers.js';
import { loadOrgFor } from './org-access.js';
import { findKpi } from './lookup.js';

async function kpiByIdOrCode(client, idOrCode, orgSlug, membership = { role: 'owner' }) {
  const out = await findKpi(client, membership, idOrCode, orgSlug);
  return out.kpi;
}

/** Accepts goals as [{how_often,target}], {"Every day": 20, ...}, or legacy how_often + target. */
export function parseGoalsInput(body) {
  const raw = body?.goals;
  let list = null;
  if (Array.isArray(raw)) {
    list = raw.map((g) => ({ how_often: normalizeHowOften(g?.how_often ?? g?.cadence), target: g?.target ?? g?.goal ?? null }));
  } else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([k, v]) => ({ how_often: normalizeHowOften(k), target: v }));
  }
  if (!list) return null;
  const out = new Map();
  for (const g of list) {
    if (!CADENCES.includes(g.how_often)) {
      return { error: { code: 'invalid', message: `Unknown how_often "${g.how_often}". Use: ${CADENCES.join(', ')}.` } };
    }
    const t = g.target === '' || g.target == null ? null : Number(g.target);
    if (t != null && !Number.isFinite(t)) {
      return { error: { code: 'invalid', message: `Goal for ${g.how_often} must be a number.` } };
    }
    out.set(g.how_often, t);
  }
  if (!out.size) return { error: { code: 'invalid', message: 'Track the KPI at least once (day, week, month or quarter).' } };
  return { goals: [...out.entries()].map(([how_often, target]) => ({ how_often, target })) };
}

export async function goalsFor(client, kpiIds) {
  const map = new Map();
  if (!kpiIds.length) return map;
  const { rows } = await dbQuery(
    client,
    `SELECT kpi_id, how_often, target FROM kpi_goals WHERE kpi_id = ANY($1::uuid[])`,
    [kpiIds],
  );
  for (const r of rows) {
    if (!map.has(r.kpi_id)) map.set(r.kpi_id, []);
    map.get(r.kpi_id).push({ how_often: r.how_often, target: r.target == null ? null : Number(r.target) });
  }
  for (const list of map.values()) list.sort((a, b) => cadenceRank(a.how_often) - cadenceRank(b.how_often));
  return map;
}

async function syncBaseFromGoals(client, kpi) {
  const goals = (await goalsFor(client, [kpi.id])).get(kpi.id) ?? [];
  const base = baseCadence(goals.map((g) => g.how_often));
  const baseGoal = goals.find((g) => g.how_often === base)?.target ?? null;
  const bands = deriveBands(baseGoal, kpi.direction);
  const { rows } = await dbQuery(
    client,
    `UPDATE kpis SET how_often = $2, target = $3, green_at = $4, amber_at = $5, version = version + 1
     WHERE id = $1 RETURNING *`,
    [kpi.id, base, baseGoal, bands.green_at, bands.amber_at],
  );
  return { ...rows[0], goals };
}

/** Replace the tracked cadences of a KPI with `goals`. */
async function replaceGoals(client, kpi, goals, membership) {
  await dbQuery(
    client,
    `DELETE FROM kpi_goals WHERE kpi_id = $1 AND NOT (how_often::text = ANY($2::text[]))`,
    [kpi.id, goals.map((g) => g.how_often)],
  );
  for (const g of goals) await upsertGoal(client, kpi.id, g.how_often, g.target, membership);
}

async function upsertGoal(client, kpiId, howOften, target, membership) {
  await dbQuery(
    client,
    `INSERT INTO kpi_goals (kpi_id, how_often, target, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kpi_id, how_often) DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kpiId, howOften, target, membership.id],
  );
}

export async function listKpisForOrg(client, membership, orgSlug) {
  const loaded = await loadOrgFor(client, membership, orgSlug);
  if (loaded.error) return loaded;
  const { rows } = await dbQuery(
    client,
    `SELECT k.*, u.full_name AS owner_name, m.role AS owner_role
     FROM kpis k
     LEFT JOIN memberships m ON m.id = k.owner_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE k.org_id = $1 AND k.status = 'active'
     ORDER BY k.code`,
    [loaded.org.id],
  );
  const goals = await goalsFor(client, rows.map((r) => r.id));
  return {
    kpis: rows.map((r) => ({
      ...r,
      goals: goals.get(r.id) ?? [{ how_often: r.how_often, target: r.target == null ? null : Number(r.target) }],
    })),
  };
}

export async function addKpi(client, membership, orgSlug, body) {
  const loaded = await loadOrgFor(client, membership, orgSlug);
  if (loaded.error) return loaded;
  if (!isOwner(membership)) {
    return {
      error: {
        code: 'forbidden',
        message: 'Only Thyagu can add a KPI. Managers and members follow the register as given.',
      },
    };
  }
  const { code, name, unit, how_often, cadence, target, direction } = body ?? {};
  if (!code || !name) return { error: { code: 'invalid', message: 'Name and code are required.' } };
  const parsed = parseGoalsInput(body) ?? {
    goals: [{ how_often: normalizeHowOften(how_often ?? cadence) ?? HOW_OFTEN_DEFAULT, target: target === '' || target == null ? null : Number(target) }],
  };
  if (parsed.error) return parsed;
  const base = baseCadence(parsed.goals.map((g) => g.how_often));
  const numericTarget = parsed.goals.find((g) => g.how_often === base)?.target ?? null;
  const dir = direction === 'lower_is_better' ? 'lower_is_better' : 'higher_is_better';
  const bands = deriveBands(numericTarget, dir);
  const { rows } = await dbQuery(
    client,
    `INSERT INTO kpis (org_id, code, name, unit, owned_at_level, owner_id, how_often, direction, target, green_at, amber_at, source_tag, rationale, created_by)
     VALUES ($1,$2,$3,$4,'manager',$5,$6,$7,$8,$9,$10,'derived','Added from the dashboard',$5)
     RETURNING *`,
    [
      loaded.org.id,
      code,
      name,
      unit || 'count',
      membership.id,
      base,
      dir,
      numericTarget,
      bands.green_at,
      bands.amber_at,
    ],
  );
  for (const g of parsed.goals) await upsertGoal(client, rows[0].id, g.how_often, g.target, membership);
  return { kpi: { ...rows[0], goals: parsed.goals } };
}

export async function updateKpiRegister(client, membership, kpiRef, body, orgSlug) {
  const kpi = await kpiByIdOrCode(client, kpiRef, orgSlug);
  if (!kpi) return { error: { code: 'not_found', message: 'KPI not found' } };
  const loaded = await loadOrgFor(client, membership, kpi.slug);
  if (loaded.error) return loaded;

  const { name, unit, how_often, cadence, target, goals, rollup_method } = body ?? {};
  if (rollup_method !== undefined) {
    if (!isOwner(membership)) return { error: { code: 'forbidden', message: 'Only Thyagu can change how a KPI rolls up.' } };
    if (!['sum', 'average', 'latest', 'manual'].includes(rollup_method)) {
      return { error: { code: 'invalid', message: 'rollup_method must be sum, average, latest or manual.' } };
    }
    await dbQuery(client, `UPDATE kpis SET rollup_method = $2 WHERE id = $1`, [kpi.id, rollup_method]);
    const others = [name, unit, how_often, cadence, target, goals].some((v) => v !== undefined);
    if (!others) return { kpi: { ...kpi, rollup_method } };
  }
  const wantsRegisterEdit =
    goals !== undefined ||
    name !== undefined ||
    unit !== undefined ||
    how_often !== undefined ||
    cadence !== undefined ||
    target !== undefined;

  if (!wantsRegisterEdit) {
    return { error: { code: 'invalid', message: 'Nothing to update.' } };
  }
  if (!isOwner(membership)) {
    return {
      error: {
        code: 'forbidden',
        message: 'Only Thyagu can change KPI name, goal, or cadence. Managers can reassign who owns it.',
      },
    };
  }

  if (goals !== undefined) {
    const parsed = parseGoalsInput(body);
    if (parsed?.error) return parsed;
    if (name !== undefined || unit !== undefined) {
      await dbQuery(client, `UPDATE kpis SET name = COALESCE($2, name), unit = COALESCE($3, unit) WHERE id = $1`, [kpi.id, name ?? null, unit ?? null]);
    }
    await replaceGoals(client, kpi, parsed.goals, membership);
    return { kpi: await syncBaseFromGoals(client, kpi) };
  }

  const numericTarget =
    target === undefined
      ? kpi.target
      : target === '' || target == null
        ? null
        : Number(target);
  const often = how_often ?? cadence;
  const bands = deriveBands(numericTarget, kpi.direction);
  const { rows: updated } = await dbQuery(
    client,
    `UPDATE kpis SET
       name = COALESCE($2, name),
       unit = COALESCE($3, unit),
       how_often = COALESCE($4, how_often),
       target = $5,
       green_at = $6,
       amber_at = $7,
       version = version + 1
     WHERE id = $1 RETURNING *`,
    [
      kpi.id,
      name ?? null,
      unit ?? null,
      often != null ? normalizeHowOften(often) : null,
      numericTarget,
      bands.green_at,
      bands.amber_at,
    ],
  );
  // Legacy single-cadence edit: keep kpi_goals in step with the base cadence.
  if (often != null) {
    await dbQuery(client, `DELETE FROM kpi_goals WHERE kpi_id = $1 AND how_often <> $2`, [kpi.id, updated[0].how_often]);
  }
  await upsertGoal(client, kpi.id, updated[0].how_often, numericTarget, membership);
  return { kpi: await syncBaseFromGoals(client, updated[0]) };
}

export async function assignKpiOwner(client, membership, kpiRef, body, orgSlug) {
  const kpi = await kpiByIdOrCode(client, kpiRef, orgSlug);
  if (!kpi) return { error: { code: 'not_found', message: 'KPI not found' } };
  const loaded = await loadOrgFor(client, membership, kpi.slug);
  if (loaded.error) return loaded;
  if (!managesOrg(membership, loaded.org)) {
    return {
      error: { code: 'forbidden', message: 'Only the manager (or Thyagu) can assign who owns a KPI.' },
    };
  }

  const nextOwnerId = body?.owner_id ?? body?.membership_id;
  if (nextOwnerId === undefined) {
    return { error: { code: 'invalid', message: 'owner_id or membership_id is required.' } };
  }

  let ownerId = kpi.owner_id;
  let ownedAtLevel = kpi.owned_at_level;
  if (nextOwnerId === null || nextOwnerId === '') {
    ownerId = null;
    ownedAtLevel = ROLE.MANAGER;
  } else {
    const { rows: ownerRows } = await dbQuery(
      client,
      `SELECT id, role FROM memberships
       WHERE id = $1 AND org_id = $2 AND state <> 'inactive'`,
      [nextOwnerId, loaded.org.id],
    );
    const person = ownerRows[0];
    if (!person) {
      return { error: { code: 'invalid', message: 'Owner must be an active person in this organisation.' } };
    }
    ownerId = person.id;
    ownedAtLevel = person.role === ROLE.OWNER ? ROLE.MANAGER : person.role;
  }

  const { rows: updated } = await dbQuery(
    client,
    `UPDATE kpis SET owner_id = $2, owned_at_level = $3, version = version + 1 WHERE id = $1 RETURNING *`,
    [kpi.id, ownerId, ownedAtLevel],
  );
  if (kpi.owner_id !== ownerId) {
    await dbQuery(
      client,
      `INSERT INTO kpi_audit (kpi_id, field, old_value, new_value, reason, changed_by)
       VALUES ($1,'owner_id',$2,$3,'reassigned from agent',$4)`,
      [
        kpi.id,
        kpi.owner_id == null ? null : String(kpi.owner_id),
        ownerId == null ? null : String(ownerId),
        membership.id,
      ],
    );
  }
  return { kpi: updated[0] };
}

export async function retireKpi(client, membership, kpiRef, orgSlug) {
  const kpi = await kpiByIdOrCode(client, kpiRef, orgSlug);
  if (!kpi) return { error: { code: 'not_found', message: 'KPI not found' } };
  const loaded = await loadOrgFor(client, membership, kpi.slug);
  if (loaded.error) return loaded;
  if (!isOwner(membership)) {
    return {
      error: {
        code: 'forbidden',
        message: 'Only Thyagu can remove a KPI. Managers and members follow the register as given.',
      },
    };
  }
  await dbQuery(client, `UPDATE kpis SET status = 'retired' WHERE id = $1`, [kpi.id]);
  return { ok: true, kpi_code: kpi.code };
}

export async function setTargetByCode(client, membership, body) {
  const field = body.field || 'goal';
  if (field !== 'goal' && field !== 'target') {
    return {
      error: {
        code: 'invalid',
        message: 'Only goal can be set. Colour bands are automatic (green at goal, amber from 80%).',
      },
    };
  }
  if (body.kpi_code == null || body.value === undefined) {
    return { error: { code: 'invalid', message: 'kpi_code and value are required' } };
  }
  if (!isOwner(membership)) {
    return { error: { code: 'forbidden', message: 'Only Thyagu can set a KPI goal.' } };
  }
  const found = await findKpi(client, membership, body.kpi_code, body.org_slug);
  if (found.error) return found;
  const kpi = found.kpi;
  const numeric = Number(body.value);
  if (!Number.isFinite(numeric)) {
    return { error: { code: 'invalid', message: 'value must be a number' } };
  }
  const cadence = normalizeHowOften(body.how_often ?? body.cadence ?? kpi.how_often);
  if (!CADENCES.includes(cadence)) {
    return { error: { code: 'invalid', message: `how_often must be one of: ${CADENCES.join(', ')}` } };
  }
  const { rows: prev } = await dbQuery(
    client,
    `SELECT target FROM kpi_goals WHERE kpi_id = $1 AND how_often = $2`,
    [kpi.id, cadence],
  );
  const oldVal = prev[0]?.target ?? null;
  await upsertGoal(client, kpi.id, cadence, numeric, membership);
  const synced = await syncBaseFromGoals(client, kpi);
  await dbQuery(
    client,
    `INSERT INTO kpi_audit (kpi_id, field, old_value, new_value, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [kpi.id, `goal:${cadence}`, oldVal == null ? null : String(oldVal), String(numeric), body.reason ?? 'agent', membership.id],
  );
  return {
    ok: true,
    kpi_code: kpi.code,
    kpi_name: kpi.name,
    field: 'goal',
    how_often: cadence,
    value: numeric,
    goals: synced.goals,
    bands: BANDS_NOTE,
  };
}
