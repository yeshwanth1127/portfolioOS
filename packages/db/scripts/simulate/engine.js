/**
 * The simulation itself: one pass through every day, in order, so everything lines up —
 * who was in, what they worked on, which numbers were entered, approved, locked and scored.
 */
import { scoreOrgDay } from '../../../api/src/scoring.js';
import { addDays, at, daysBetween, dow, insertRows, isLastWeekdayOfMonth, rng, todayIn, uuid } from './lib.js';
import { COMMENTS, GENERIC_PROJECTS, PROJECTS, REVIEW_BACK, REVIEW_OK, UPDATES, VISITS } from './content.js';
import { assignKpiOwners, buildStructure, loadPeople, prepareKpis } from './structure.js';

const MIN = 60;

function roundFor(kpi, v) {
  if (kpi.unit === '%') return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
  if (kpi.unit === 'INR') return Math.max(0, Math.round(v / 500) * 500);
  if (kpi.unit === 'hours') return Math.max(0, Math.round(v * 10) / 10);
  return Math.max(0, Math.round(v));
}

export async function runSimulation(db, ws, opts) {
  const q = (text, params) => db.query(text, params);
  const tz = ws.timezone || 'Asia/Kolkata';
  const r = rng(opts.seed);
  const today = todayIn(tz);
  const end = addDays(today, -1);
  const start = addDays(end, -(opts.days - 1));
  const nowMs = Date.now();
  const reg = [];
  const log = (kind, ref) => reg.push([kind, ref]);

  const { rows: orgs } = await q(
    `SELECT o.id, o.slug, o.short_name, un.id AS unit_id FROM organisations o
     LEFT JOIN units un ON un.legacy_org_id = o.id WHERE o.status = 'active' ORDER BY o.short_name`,
  );
  const ctx = { db, q, r, ws, tz, start, end, today, orgs, reg, log, opts };

  // ── Structure ────────────────────────────────────────────────────────────────────────────
  const { teams } = await buildStructure(ctx);
  const people = await loadPeople(q);
  ctx.people = people;
  const owner = people.find((p) => p.role === 'owner');
  ctx.owner = owner;
  const byId = new Map(people.map((p) => [p.id, p]));
  const managerOf = (orgId) =>
    people.find((p) => p.org_id === orgId && p.role === 'manager') ??
    people.find((p) => p.org_id === orgId && p.role === 'vice_manager') ??
    owner;
  const bossOf = (p) => {
    const parent = p.parent_id ? byId.get(p.parent_id) : null;
    if (parent && parent.role !== 'owner') return parent;
    const mgr = managerOf(p.org_id);
    return mgr && mgr.id !== p.id ? mgr : null;
  };
  const trait = new Map(
    people.map((p) => [
      p.id,
      {
        reliability: r.between(0.8, 0.99),
        perf: r.between(0.84, 1.12),
        capacity: r.between(0.75, 1.3),
        start: r.between(9 * MIN + 5, 10 * MIN + 5),
        presence: r.between(0.9, 0.98),
      },
    ]),
  );
  ctx.tasks = null; // set below
  ctx.orgPerf = new Map(orgs.map((o) => [o.id, { level: r.between(0.88, 1.06), trend: r.between(-0.05, 0.1) }]));

  const kpis = await prepareKpis(ctx);
  ctx.kpis = kpis;
  await assignKpiOwners(ctx, people);

  // ── Projects ─────────────────────────────────────────────────────────────────────────────
  const projects = [];
  const projectRows = [];
  const unitRows = [];
  for (const org of orgs) {
    if (!org.unit_id) continue;
    const mgr = managerOf(org.id);
    const orgTeams = teams.filter((t) => t.org_id === org.id);
    for (const [pi, [name, titles]] of (PROJECTS[org.slug] ?? GENERIC_PROJECTS).entries()) {
      const id = uuid();
      const team = orgTeams.length ? orgTeams[pi % orgTeams.length] : null;
      const p = { id, org_id: org.id, name, titles, manager_id: mgr.id, team, pos: 0 };
      projects.push(p);
      projectRows.push([id, org.unit_id, name, `${name} — ${org.short_name}`, mgr.id, 'active', r.pick(['normal', 'high', 'normal']),
        addDays(start, -10), addDays(end, r.int(14, 50)), at(tz, addDays(start, -10), 11 * MIN), at(tz, end, 18 * MIN), ws.id]);
      unitRows.push([id, org.unit_id, 'primary', ws.id]);
      for (const t of orgTeams) unitRows.push([id, t.id, 'participant', ws.id]);
      log('project', { id });
    }
  }
  await insertRows(q, 'projects', ['id', 'unit_id', 'name', 'description', 'manager_id', 'status', 'priority', 'starts_on', 'due_on', 'created_at', 'updated_at', 'workspace_id'], projectRows);
  await insertRows(q, 'project_units', ['project_id', 'unit_id', 'role', 'workspace_id'], unitRows);

  // ── Buffers written at the end ───────────────────────────────────────────────────────────
  const tasks = [];
  ctx.tasks = tasks;
  const activity = [];
  const comments = [];
  const updates = [];
  const notifications = [];
  const attendance = [];
  const auth = [];
  const escalations = [];
  const projectsOf = (orgId) => projects.filter((p) => p.org_id === orgId);
  const teamOf = (personId) => teams.find((t) => t.members?.includes(personId));

  const past = (ts) => ts.getTime() < nowMs;
  const act = (actor, task, kind, ts, extra = {}) =>
    past(ts) && activity.push([actor, task.project_id, task.id, kind, JSON.stringify({ sim: true, title: task.title, ...extra }), ts, ws.id]);

  function newTask(creator, assignee, day, minutes) {
    const pool = projectsOf(assignee.org_id);
    if (!pool.length) return null;
    const team = teamOf(assignee.id);
    const preferred = pool.filter((p) => p.team && team && p.team.id === team.id);
    const project = preferred.length && r.chance(0.7) ? r.pick(preferred) : r.pick(pool);
    const base = project.titles[project.pos % project.titles.length];
    project.pos += 1;
    // Recurring work reads like real tickets: "Weekly closure review — w/c 10 Nov".
    const monday = addDays(day, -((dow(day) + 6) % 7));
    const label = new Date(`${monday}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const title = project.pos <= project.titles.length ? base : `${base} — w/c ${label}`;
    const effort = Math.round(r.between(0.4, 2.2) * 10) / 10;
    const created = at(tz, day, minutes);
    let due = day;
    for (let left = Math.ceil(effort * 1.6) + r.int(1, 4); left > 0; ) {
      due = addDays(due, 1);
      if (dow(due) !== 0) left -= 1;
    }
    const t = {
      id: uuid(),
      project_id: project.id,
      title,
      assignee_id: assignee.id,
      reviewer_id: creator.id === assignee.id ? bossOf(assignee)?.id ?? null : creator.id,
      created_by: creator.id,
      created_at: created,
      updated_at: created,
      due_on: due,
      priority: r.pick(['low', 'normal', 'normal', 'normal', 'high', 'high', 'urgent']),
      effort,
      left: effort,
      status: 'todo',
      completed_at: null,
      position: project.pos,
    };
    if (!past(created)) return null;
    tasks.push(t);
    act(creator.id, t, 'task.created', created);
    if (creator.id !== assignee.id) {
      const readAt = r.chance(0.85) ? new Date(created.getTime() + r.int(10, 600) * 60000) : null;
      notifications.push([assignee.id, 'assigned', t.id, t.project_id, `${creator.name} assigned you: ${t.title}`.slice(0, 480), 'in_app',
        readAt && past(readAt) ? readAt : null, created, ws.id]);
    }
    return t;
  }

  const openTasks = (personId) => tasks.filter((t) => t.assignee_id === personId && ['todo', 'in_progress'].includes(t.status));

  // Initial backlog two weeks before the window (a workspace already in use).
  const kickoff = addDays(start, -3);
  for (const p of people) {
    if (p.role === 'owner') continue;
    const boss = bossOf(p) ?? p;
    for (let i = r.int(1, 3); i > 0; i -= 1) newTask(boss, p, kickoff, r.int(10 * MIN, 16 * MIN));
  }

  // ── Day loop ─────────────────────────────────────────────────────────────────────────────
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  if (opts.today) days.push(today);
  const realDays = new Set(
    (await q(`SELECT org_id, period_date FROM org_periods WHERE period_date BETWEEN $1 AND $2`, [start, today])).rows.map((x) => `${x.org_id}|${x.period_date}`),
  );
  const openOrgDays = new Map(); // org -> [day]
  const pendingSubs = []; // { id, org, day, validator }
  const redStreak = new Map();
  const leave = new Map();
  let kpiNumbers = 0;
  let lockedDays = 0;

  for (const [i, day] of days.entries()) {
    const wd = dow(day);
    const isToday = day === today;
    if (wd === 0) continue;
    const progress = i / Math.max(1, days.length - 1);

    const actStart = activity.length;
    const comStart = comments.length;
    // Who is in, and when.
    const present = new Map();
    for (const p of people) {
      if (p.role === 'owner') {
        const ts = at(tz, day, r.int(9 * MIN + 30, 11 * MIN));
        if (r.chance(wd === 6 ? 0.3 : 0.85) && past(ts)) {
          auth.push([p.id, 'login', ts, 'web', 'sim', ws.id]);
          present.set(p.id, { inMin: 10 * MIN, outMin: 18 * MIN });
        }
        continue;
      }
      const t = trait.get(p.id);
      if ((leave.get(p.id) ?? 0) > 0) {
        leave.set(p.id, leave.get(p.id) - 1);
        continue;
      }
      if (r.chance(0.02)) {
        leave.set(p.id, r.int(0, 2));
        continue;
      }
      if (!r.chance(wd === 6 ? 0.55 : t.presence)) continue;
      const inMin = Math.round(Math.max(8 * MIN + 40, Math.min(11 * MIN, r.normal(t.start, 18))));
      const outMin = Math.round(Math.min(21 * MIN, inMin + (wd === 6 ? 300 : 510) + r.normal(0, 40)));
      const inAt = at(tz, day, inMin);
      if (!past(inAt)) continue;
      present.set(p.id, { inMin, outMin });
      attendance.push([p.id, 'in', inAt, 'web', 'sim', ws.id]);
      const outAt = at(tz, day, outMin);
      if (!r.chance(0.04) && past(outAt)) attendance.push([p.id, 'out', outAt, 'web', 'sim', ws.id]);
      auth.push([p.id, 'login', at(tz, day, inMin + r.int(1, 15)), 'web', 'sim', ws.id]);
      if (r.chance(0.2)) {
        const again = at(tz, day, inMin + r.int(180, 300));
        if (past(again)) auth.push([p.id, 'login', again, 'web', 'sim', ws.id]);
      }
      if (r.chance(0.35) && past(outAt)) auth.push([p.id, 'logout', new Date(outAt.getTime() - r.int(0, 5) * 60000), 'web', 'sim', ws.id]);
    }
    const when = (id, lo = 0.05, hi = 0.95) => {
      const a = present.get(id);
      return at(tz, day, a.inMin + (a.outMin - a.inMin) * r.between(lo, hi));
    };

    // Planning: Monday sprint planning, plus anyone with an empty list gets work.
    for (const p of people) {
      if (p.role === 'owner' || !present.has(p.id)) continue;
      const boss = bossOf(p) ?? p;
      const n = wd === 1 ? r.int(1, 3) : openTasks(p.id).length === 0 ? 1 : r.chance(0.12) ? 1 : 0;
      for (let k = 0; k < n; k += 1) {
        const creatorIn = present.get(boss.id);
        newTask(boss, p, day, creatorIn ? creatorIn.inMin + r.int(5, 90) : present.get(p.id).inMin + r.int(5, 30));
      }
    }

    // Work: everyone who is in moves their tasks forward.
    const doneToday = [];
    for (const p of people) {
      if (p.role === 'owner' || !present.has(p.id)) continue;
      let cap = trait.get(p.id).capacity * r.between(0.6, 1.25) * (wd === 6 ? 0.6 : 1);
      const queue = openTasks(p.id).sort((a, b) => (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0) || a.due_on.localeCompare(b.due_on));
      for (const t of queue) {
        if (cap <= 0) break;
        const ts = when(p.id);
        if (!past(ts)) break;
        if (t.status === 'todo') {
          t.status = 'in_progress';
          t.updated_at = ts;
          act(p.id, t, 'task.updated', ts, { status: 'in_progress' });
        }
        const spend = Math.min(cap, t.left);
        t.left -= spend;
        cap -= spend;
        if (r.chance(0.3)) comments.push([t.id, p.id, r.pick(COMMENTS), when(p.id, 0.3, 0.98), ws.id]);
        if (t.left <= 0.01) {
          const doneAt = when(p.id, 0.5, 0.99);
          if (!past(doneAt)) continue;
          if (t.reviewer_id) {
            t.status = 'in_review';
            t.updated_at = doneAt;
            act(p.id, t, 'task.updated', doneAt, { status: 'in_review' });
          } else {
            t.status = 'done';
            t.completed_at = doneAt;
            t.updated_at = doneAt;
            act(p.id, t, 'task.completed', doneAt, { status: 'done' });
            doneToday.push(t);
          }
        }
      }
    }

    // Reviews: whoever is in closes what is waiting for them.
    for (const t of tasks.filter((x) => x.status === 'in_review' && present.has(x.reviewer_id))) {
      const ts = when(t.reviewer_id, 0.1, 0.99);
      if (!past(ts) || ts < t.updated_at) continue;
      if (r.chance(0.9)) {
        t.status = 'done';
        t.completed_at = ts;
        t.updated_at = ts;
        act(t.reviewer_id, t, 'task.completed', ts, { status: 'done' });
        if (r.chance(0.5)) comments.push([t.id, t.reviewer_id, r.pick(REVIEW_OK), ts, ws.id]);
        doneToday.push(t);
      } else {
        t.status = 'in_progress';
        t.left = 0.4;
        t.updated_at = ts;
        act(t.reviewer_id, t, 'task.updated', ts, { status: 'in_progress' });
        comments.push([t.id, t.reviewer_id, r.pick(REVIEW_BACK), ts, ws.id]);
      }
    }

    // Friday: managers post project updates.
    if (wd === 5) {
      for (const p of projects) {
        if (!present.has(p.manager_id) || !r.chance(0.85)) continue;
        const ts = at(tz, day, present.get(p.manager_id).outMin - r.int(20, 90));
        if (past(ts)) updates.push([p.id, p.manager_id, r.pick(UPDATES), ts, ws.id]);
      }
    }

    // KPI numbers, approval, lock and scoring.
    for (const org of orgs) {
      const key = `${org.id}|${day}`;
      const mgr = managerOf(org.id);
      const mgrIn = present.get(mgr.id);

      // Morning: approve numbers left from yesterday, close days left open.
      if (mgrIn) {
        for (const s of pendingSubs.filter((x) => x.org === org.id && !x.done)) {
          const ts = at(tz, day, mgrIn.inMin + r.int(10, 60));
          if (!past(ts) || (openOrgDays.get(org.id) ?? []).every((d) => d !== s.day)) continue;
          await q(`UPDATE submissions SET state = 'validated', validated_by = $2, validated_at = $3 WHERE id = $1 AND state = 'submitted'`, [s.id, mgr.id, ts]);
          s.done = true;
        }
        for (const d of [...(openOrgDays.get(org.id) ?? [])]) {
          if (d === day) continue;
          const ts = at(tz, day, mgrIn.inMin + r.int(30, 90));
          if (!past(ts) || !r.chance(0.8)) continue;
          await lockDay(org, d, mgr, ts);
        }
      }
      if (realDays.has(key)) continue;

      let wrote = 0;
      for (const k of kpis.filter((x) => x.org_id === org.id && !x.unmeasured)) {
        const due =
          k.base === 'Every day' ||
          (k.base === 'Every week' && wd === 5) ||
          (k.base === 'Every month' && isLastWeekdayOfMonth(day)) ||
          (k.base === 'Every quarter' && isLastWeekdayOfMonth(day) && ['03', '06', '09', '12'].includes(day.slice(5, 7)));
        if (!due) continue;
        const by = k.owner_id && present.has(k.owner_id) ? k.owner_id : null;
        if (!by || !r.chance(trait.get(by)?.reliability ?? 0.9)) continue;
        const who = byId.get(by);
        const t = trait.get(by);
        const op = ctx.orgPerf.get(org.id);
        const factor = Math.max(0.3, (op.level + op.trend * progress) * t.perf * (wd === 1 ? 0.95 : 1) * r.normal(1, 0.12));
        const raw = k.direction === 'lower_is_better' ? k.goal / factor : k.goal * (k.unit === '%' ? Math.min(factor, 1.08) : factor);
        const submittedAt = at(tz, day, Math.max(present.get(by).inMin + 60, present.get(by).outMin - r.int(15, 90)));
        if (!past(submittedAt)) continue;
        const validator = who.role === 'member' && bossOf(who)?.role === 'team_lead' ? bossOf(who) : mgr;
        const valIn = present.get(validator.id);
        const validatedAt = valIn ? new Date(submittedAt.getTime() + r.int(15, 120) * 60000) : null;
        const roll = r.next();
        let state = 'submitted';
        if (validatedAt && past(validatedAt)) state = roll < 0.025 ? 'rejected' : 'validated';
        const id = uuid();
        const res = await q(
          `INSERT INTO submissions (id, org_id, kpi_id, period_date, level, value, state, submitted_by, submitted_at,
                                    validated_by, validated_at, reject_reason, channel, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'sim',$13) ON CONFLICT (kpi_id, period_date, level) DO NOTHING`,
          [id, org.id, k.id, day, who.role === 'owner' ? 'owner' : who.role, roundFor(k, raw), state, by, submittedAt,
            state === 'submitted' ? null : validator.id, state === 'submitted' ? null : validatedAt,
            state === 'rejected' ? 'Please recheck against the register.' : null, ws.id],
        );
        if (!res.rowCount) continue;
        wrote += 1;
        kpiNumbers += 1;
        if (state === 'submitted') pendingSubs.push({ id, org: org.id, day, done: false });
      }
      if (!wrote) continue;
      await q(`INSERT INTO org_periods (org_id, period_date, workspace_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [org.id, day, ws.id]);
      log('org_day', { org_id: org.id, date: day });
      openOrgDays.set(org.id, [...(openOrgDays.get(org.id) ?? []), day]);
      const lockAt = mgrIn ? at(tz, day, Math.min(22 * MIN, mgrIn.outMin + r.int(-30, 60))) : null;
      if (lockAt && past(lockAt) && r.chance(0.9)) await lockDay(org, day, mgr, lockAt);
    }

    // Everyone who was in leaves at least one trace of work.
    const touchedToday = new Set([...activity.slice(actStart).map((x) => x[0]), ...comments.slice(comStart).map((x) => x[1])]);
    for (const p of people) {
      if (p.role === 'owner' || !present.has(p.id)) continue;
      const ts = when(p.id, 0.2, 0.9);
      if (!past(ts)) continue;
      if (touchedToday.has(p.id)) continue;
      const mine = tasks.filter((t) => t.assignee_id === p.id && t.status !== 'done').sort((a, b) => b.created_at - a.created_at)[0];
      if (mine) comments.push([mine.id, p.id, r.pick(COMMENTS), ts, ws.id]);
    }

  }

  async function lockDay(org, day, mgr, ts) {
    await q(`UPDATE org_periods SET status = 'locked', locked_by = $3, locked_at = $4 WHERE org_id = $1 AND period_date = $2`, [org.id, day, mgr.id, ts]);
    await q(`INSERT INTO signoffs (org_id, period_date, manager_id, locked_at, workspace_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, period_date) DO NOTHING`, [
      org.id, day, mgr.id, ts, ws.id,
    ]);
    await q(`UPDATE submissions SET state = 'locked' WHERE org_id = $1 AND period_date = $2 AND state = 'validated' AND channel = 'sim'`, [org.id, day]);
    await scoreOrgDay(db, org.id, day);
    openOrgDays.set(org.id, (openOrgDays.get(org.id) ?? []).filter((d) => d !== day));
    lockedDays += 1;
    // Three bad scores in a row on a KPI → escalation to the owner.
    const { rows } = await q(
      `SELECT s.kpi_id, s.rag::text AS rag FROM scores s WHERE s.org_id = $1 AND s.period_date = $2`,
      [org.id, day],
    );
    for (const k of kpis.filter((x) => x.org_id === org.id)) {
      const row = rows.find((x) => x.kpi_id === k.id && x.rag !== 'unscored');
      if (!row) continue;
      const streak = row.rag === 'red' ? (redStreak.get(k.id) ?? 0) + 1 : 0;
      redStreak.set(k.id, streak);
      if (streak === 3) {
        const decided = r.chance(0.6) ? new Date(ts.getTime() + r.int(1, 3) * 86400000) : null;
        escalations.push([uuid(), org.id, 'kpi_off_track', k.id, `${k.name} has been bad for 3 scored days in a row.`, mgr.id, owner.id,
          decided && past(decided) ? 'decided' : 'open', decided && past(decided) ? r.pick(['accepted', 'goal reviewed', 'action plan agreed']) : null,
          decided && past(decided) ? decided : null, ts, ws.id]);
      }
    }
  }

  // ── Milestones (3 per project), decided from how the project's tasks went ───────────────
  const milestones = [];
  const span = daysBetween(start, end);
  for (const p of projects) {
    for (let m = 1; m <= 3; m += 1) {
      const due = addDays(start, Math.round((span * m) / 3.2) + r.int(-2, 2));
      const own = tasks.filter((t) => t.project_id === p.id && t.due_on <= due);
      const doneBy = own.filter((t) => t.completed_at && t.completed_at <= at(tz, addDays(due, 2), 20 * MIN)).length;
      const met = due <= end && own.length && doneBy / own.length >= 0.75;
      const doneOn = met ? addDays(due, r.int(-2, 1)) : null;
      milestones.push([uuid(), p.id, `${p.name.split(' —')[0]} · milestone ${m}`, due, p.manager_id, met ? 'done' : 'open',
        met ? at(tz, doneOn, 17 * MIN) : null, at(tz, addDays(start, -10), 11 * MIN), ws.id]);
    }
  }

  // ── Calendar: weekly reviews, monthly portfolio review, visits (past and next 2 weeks) ──
  const events = [];
  const participants = [];
  const horizon = addDays(today, 14);
  const event = (orgId, title, kind, day, startMin, durMin, creator, who) => {
    const id = uuid();
    events.push([id, orgId, title, kind, at(tz, day, startMin), at(tz, day, startMin + durMin), creator, at(tz, addDays(day, -5), 11 * MIN), ws.id]);
    for (const m of who) {
      const resp = day < today ? r.pick(['yes', 'yes', 'yes', 'maybe', 'no']) : r.pick(['yes', 'pending', 'pending', 'maybe']);
      participants.push([id, m, resp, ws.id]);
    }
    log('event', { id });
  };
  for (let d = start; d <= horizon; d = addDays(d, 1)) {
    if (dow(d) === 1) {
      for (const org of orgs) {
        const mgr = managerOf(org.id);
        const team = people.filter((p) => p.org_id === org.id).map((p) => p.id);
        event(org.id, `${org.short_name} weekly review`, 'review', d, 10 * MIN, 45, mgr.id, team);
      }
      if (Number(d.slice(8, 10)) <= 7) {
        const managers = orgs.map((o) => managerOf(o.id).id);
        event(null, 'Monthly portfolio review', 'review', d, 15 * MIN, 90, owner.id, [owner.id, ...new Set(managers)]);
      }
    }
    if (dow(d) !== 0 && r.chance(0.18)) {
      const org = r.pick(orgs);
      const mgr = managerOf(org.id);
      const staff = people.filter((p) => p.org_id === org.id && p.role !== 'owner');
      event(org.id, `${r.pick(VISITS)} — ${org.short_name}`, 'visit', d, r.int(11, 15) * MIN, 120, mgr.id, [mgr.id, ...r.shuffle(staff).slice(0, 2).map((p) => p.id)]);
    }
  }

  // ── Write everything buffered ────────────────────────────────────────────────────────────
  await insertRows(q, 'tasks', ['id', 'project_id', 'title', 'assignee_id', 'status', 'priority', 'due_on', 'created_by', 'created_at', 'updated_at', 'completed_at', 'position', 'estimate_hours', 'workspace_id'],
    tasks.map((t) => [t.id, t.project_id, t.title, t.assignee_id, t.status, t.priority, t.due_on, t.created_by, t.created_at, t.updated_at, t.completed_at, t.position, Math.round(t.effort * 6), ws.id]));
  await insertRows(q, 'milestones', ['id', 'project_id', 'name', 'due_on', 'owner_id', 'status', 'completed_at', 'created_at', 'workspace_id'], milestones);
  await insertRows(q, 'activity_log', ['actor_id', 'project_id', 'task_id', 'kind', 'payload', 'at', 'workspace_id'], activity);
  await insertRows(q, 'comments', ['task_id', 'author_id', 'body', 'created_at', 'workspace_id'], comments.filter((c) => past(c[3])));
  await insertRows(q, 'project_updates', ['project_id', 'author_id', 'body', 'created_at', 'workspace_id'], updates);
  await insertRows(q, 'notifications', ['membership_id', 'kind', 'task_id', 'project_id', 'body', 'channel', 'read_at', 'created_at', 'workspace_id'], notifications);
  await insertRows(q, 'attendance_events', ['membership_id', 'kind', 'at', 'source', 'note', 'workspace_id'], attendance);
  await insertRows(q, 'auth_events', ['membership_id', 'kind', 'at', 'channel', 'user_agent', 'workspace_id'], auth);
  await insertRows(q, 'escalations', ['id', 'org_id', 'kind', 'kpi_id', 'body', 'raised_by', 'assigned_to', 'state', 'decision', 'decided_at', 'created_at', 'workspace_id'], escalations);
  for (const e of escalations) log('escalation', { id: e[0] });
  await insertRows(q, 'calendar_events', ['id', 'org_id', 'title', 'kind', 'starts_at', 'ends_at', 'created_by', 'created_at', 'workspace_id'], events);
  await insertRows(q, 'calendar_event_participants', ['event_id', 'membership_id', 'response', 'workspace_id'], participants, { onConflict: 'ON CONFLICT DO NOTHING' });

  for (const [kind, ref] of reg) {
    await q(`INSERT INTO sim.registry (workspace_id, kind, ref) VALUES ($1,$2,$3)`, [ws.id, kind, JSON.stringify(ref)]);
  }

  const count = (s) => tasks.filter((t) => t.status === s).length;
  return {
    workspace: ws.name,
    from: start,
    to: opts.today ? `${today} (today, so far)` : end,
    teams: teams.length,
    people_added: reg.filter(([k]) => k === 'user').length,
    people_total: people.filter((p) => p.role !== 'owner').length,
    kpi_owners_moved: reg.filter(([k]) => k === 'kpi_owner').length,
    kpi_goals_filled: reg.filter(([k]) => k === 'kpi_goal').length,
    kpi_numbers: kpiNumbers,
    org_days_locked: lockedDays,
    escalations: escalations.length,
    projects: projects.length,
    tasks: { total: tasks.length, done: count('done'), in_review: count('in_review'), in_progress: count('in_progress'), todo: count('todo') },
    comments: comments.length,
    project_updates: updates.length,
    calendar_events: events.length,
    clock_events: attendance.length,
    sign_in_events: auth.length,
  };
}
