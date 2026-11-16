/**
 * Organisation structure for the simulation: teams under each organisation, team leads and
 * members (simulated staff), KPI owners spread across the team, and goals for KPIs without one.
 */
import { hashPassword } from '../../../api/src/core/passwords.js';
import { CAD_RANK, addDays, at, insertRows, uuid } from './lib.js';
import { FIRST, GENERIC_TEAMS, LAST, TEAMS } from './content.js';

export async function loadPeople(q) {
  const { rows } = await q(
    `SELECT m.id, m.org_id, m.role::text AS role, m.parent_id, u.full_name AS name, u.email,
            a.unit_id AS assignment_unit
     FROM memberships m JOIN users u ON u.id = m.user_id
     LEFT JOIN assignments a ON a.id = m.id
     WHERE m.state <> 'inactive'
     ORDER BY m.created_at`,
  );
  return rows;
}

/** Teams + simulated staff. Returns { teams: [{ id, org_id, name, focus, lead_id }] }. */
export async function buildStructure(ctx) {
  const { q, r, ws, tz, start, orgs, log, opts } = ctx;
  const teams = [];
  const used = new Set((await loadPeople(q)).map((p) => p.name));
  const pw = opts.people ? await hashPassword(process.env.DEMO_PASSWORD || 'password123') : null;
  const joined = at(tz, addDays(start, -14), 10 * 60);

  for (const org of orgs) {
    if (!org.unit_id) continue;
    const defs = TEAMS[org.slug] ?? GENERIC_TEAMS;
    const existing = await loadPeople(q);
    const manager =
      existing.find((p) => p.org_id === org.id && p.role === 'manager') ??
      existing.find((p) => p.org_id === org.id && p.role === 'vice_manager');
    for (const [ti, [teamName, focus]] of defs.entries()) {
      const { rows: unit } = await q(
        `INSERT INTO units (workspace_id, parent_id, type, name, short_name, status, created_at)
         VALUES ($1,$2,'team',$3,$4,'active',$5) RETURNING id`,
        [ws.id, org.unit_id, teamName, teamName.split(' ')[0], joined],
      );
      log('unit', { id: unit[0].id });
      const team = { id: unit[0].id, org_id: org.id, name: teamName, focus, lead_id: null, index: ti };
      teams.push(team);
      if (!opts.people) continue;

      // A real team lead already in this org leads the first team; otherwise a simulated lead.
      const realLead = ti === 0 ? existing.find((p) => p.org_id === org.id && p.role === 'team_lead') : null;
      const size = r.int(3, 4);
      const members = [];
      const mk = async (role, parentId, title) => {
        let name;
        do name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
        while (used.has(name));
        used.add(name);
        const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${org.slug}@sim.orbit.local`;
        const userId = uuid();
        const memberId = uuid();
        await q(`INSERT INTO users (id, full_name, email, password_hash, is_named, created_at) VALUES ($1,$2,$3,$4,true,$5)`, [
          userId, name, email, pw, joined,
        ]);
        await q(`INSERT INTO workspace_members (workspace_id, user_id, workspace_role) VALUES ($1,$2,'member')`, [ws.id, userId]);
        await q(
          `INSERT INTO memberships (id, user_id, org_id, role, title, parent_id, state, workspace_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
          [memberId, userId, org.id, role, title, parentId, ws.id, joined],
        );
        log('user', { user_id: userId, membership_id: memberId });
        return memberId;
      };
      const leadId = realLead?.id ?? (await mk('team_lead', manager?.id ?? null, `${teamName} lead`));
      team.lead_id = leadId;
      for (let i = 0; i < size; i += 1) {
        members.push(await mk('member', leadId, r.pick(['Executive', 'Associate', 'Coordinator', 'Specialist', 'Analyst'])));
      }
      team.members = [leadId, ...members];
    }
  }

  // Assignments (units) for everyone new, then put team staff in their team units.
  const { rows: hasSync } = await q(`SELECT to_regprocedure('auth.sync_units_from_legacy()') IS NOT NULL AS ok`);
  if (hasSync[0].ok) await q(`SELECT auth.sync_units_from_legacy()`);
  for (const t of teams) {
    for (const id of t.members ?? []) {
      const sim = ctx.reg.some(([k, ref]) => k === 'user' && ref.membership_id === id);
      if (!sim) continue; // real people keep their assignment
      await q(
        `UPDATE assignments SET unit_id = $2, role = CASE WHEN $3 THEN 'team_lead' ELSE 'contributor' END WHERE id = $1`,
        [id, t.id, id === t.lead_id],
      );
    }
  }
  return { teams };
}

/** Spread KPI ownership: KPIs owned by a manager go to people in the organisation. */
export async function assignKpiOwners(ctx, people) {
  const { q, r, kpis, log } = ctx;
  for (const orgId of [...new Set(kpis.map((k) => k.org_id))]) {
    const staff = r.shuffle(people.filter((p) => p.org_id === orgId && ['member', 'team_lead'].includes(p.role)));
    if (!staff.length) continue;
    let i = 0;
    for (const k of kpis.filter((x) => x.org_id === orgId)) {
      const owner = people.find((p) => p.id === k.owner_id);
      if (owner && !['manager', 'vice_manager', 'owner'].includes(owner.role)) continue;
      if (!r.chance(0.7)) continue; // managers keep some KPIs
      const next = staff[i % staff.length];
      i += 1;
      log('kpi_owner', { kpi_id: k.id, owner_id: k.owner_id, owned_at_level: k.owned_at_level });
      await q(`UPDATE kpis SET owner_id = $2, owned_at_level = $3 WHERE id = $1`, [k.id, next.id, next.role]);
      k.owner_id = next.id;
    }
  }
}

function suggestGoal(kpi, cadence, r) {
  const per = { 'Every day': 1, 'Every week': 5, 'Every month': 22, 'Every quarter': 66 }[cadence] ?? 1;
  const name = kpi.name.toLowerCase();
  if (kpi.unit === '%') return kpi.direction === 'lower_is_better' ? 10 : r.pick([85, 90, 95]);
  if (kpi.unit === 'INR') return Math.round((r.between(40000, 160000) * per) / 10000) * 10000;
  if (kpi.unit === 'hours') return kpi.direction === 'lower_is_better' ? (cadence === 'Every day' ? 6 : 24) : Math.round(r.between(6, 8) * per);
  if (kpi.direction === 'lower_is_better') return Math.max(1, Math.round(per * 0.4));
  if (/active|clients|partners|programmes|projects|pipeline|network|implementations/.test(name)) return Math.round(r.between(4, 20));
  return Math.max(1, Math.round(r.between(1.5, 6) * per));
}

/** Load KPIs, work out each one's entry cadence and goal; fill empty goals. */
export async function prepareKpis(ctx) {
  const { q, r, ws, log } = ctx;
  const { rows: kpis } = await q(
    `SELECT k.id, k.org_id, k.name, k.unit, k.direction::text AS direction, k.how_often::text AS how_often,
            k.target, k.owner_id, k.owned_at_level::text AS owned_at_level, k.unmeasured,
            coalesce(json_agg(json_build_object('how_often', g.how_often, 'target', g.target)) FILTER (WHERE g.kpi_id IS NOT NULL), '[]') AS goals
     FROM kpis k LEFT JOIN kpi_goals g ON g.kpi_id = k.id
     WHERE k.status = 'active' GROUP BY k.id`,
  );
  for (const k of kpis) {
    const cadences = k.goals.length ? k.goals.map((g) => g.how_often) : [k.how_often];
    k.base = cadences.sort((a, b) => CAD_RANK[a] - CAD_RANK[b])[0];
    const baseGoal = k.goals.find((g) => g.how_often === k.base && g.target != null);
    if (baseGoal) k.goal = Number(baseGoal.target);
    else if (k.target != null && k.base === k.how_often) k.goal = Number(k.target);
    else {
      k.goal = suggestGoal(k, k.base, r);
      const hadRow = k.goals.some((g) => g.how_often === k.base);
      await q(
        `INSERT INTO kpi_goals (kpi_id, how_often, target, workspace_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (kpi_id, how_often) DO UPDATE SET target = EXCLUDED.target WHERE kpi_goals.target IS NULL`,
        [k.id, k.base, k.goal, ws.id],
      );
      log('kpi_goal', { kpi_id: k.id, how_often: k.base, had_row: hadRow });
    }
  }
  return kpis;
}

export { insertRows };
