/** Remove everything a simulation added to a workspace (driven by sim.registry and sim tags). */

const IMMUTABLE = [
  'activity_log', 'attendance_events', 'auth_events', 'audit_log',
  'target_versions', 'report_revisions', 'approvals', 'ledger_entries', 'period_results',
];

export async function resetSimulation(q, ws) {
  const { rows } = await q(`SELECT kind, ref FROM sim.registry WHERE workspace_id = $1 ORDER BY id`, [ws.id]);
  const of = (kind) => rows.filter((x) => x.kind === kind).map((x) => x.ref);
  const ids = (kind, key = 'id') => of(kind).map((x) => x[key]);
  const memberIds = ids('user', 'membership_id');
  const userIds = ids('user', 'user_id');
  const projectIds = ids('project');
  const metricIds = ids('metric');
  const unitIds = ids('unit');
  const run = (sql, params) => q(sql, params);

  const { rows: present } = await q(
    `SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1)`,
    [IMMUTABLE],
  );
  const tables = [...new Set(present.map((x) => x.t))];
  for (const t of tables) await run(`ALTER TABLE ${t} DISABLE TRIGGER USER`);

  // KPI days: scores, sign-offs, periods; then the numbers themselves.
  for (const d of of('org_day')) {
    await run(`DELETE FROM scores WHERE org_id = $1 AND period_date = $2`, [d.org_id, d.date]);
    await run(`DELETE FROM signoffs WHERE org_id = $1 AND period_date = $2`, [d.org_id, d.date]);
    await run(`DELETE FROM org_periods WHERE org_id = $1 AND period_date = $2`, [d.org_id, d.date]);
  }
  await run(`DELETE FROM submissions WHERE workspace_id = $1 AND channel = 'sim'`, [ws.id]);
  await run(`DELETE FROM escalations WHERE id = ANY($1::uuid[])`, [ids('escalation')]);

  // Ledger.
  if (metricIds.length) {
    await run(`DELETE FROM period_results WHERE metric_id = ANY($1::uuid[])`, [metricIds]);
    await run(`DELETE FROM ledger_source_claims WHERE entry_id IN (SELECT id FROM ledger_entries WHERE metric_id = ANY($1::uuid[]))`, [metricIds]);
    await run(`DELETE FROM ledger_entries WHERE metric_id = ANY($1::uuid[])`, [metricIds]);
    await run(
      `DELETE FROM approvals WHERE report_revision_id IN (
         SELECT rr.id FROM report_revisions rr JOIN reports rp ON rp.id = rr.report_id WHERE rp.metric_id = ANY($1::uuid[]))`,
      [metricIds],
    );
    await run(`DELETE FROM report_revisions WHERE report_id IN (SELECT id FROM reports WHERE metric_id = ANY($1::uuid[]))`, [metricIds]);
    await run(`DELETE FROM reports WHERE metric_id = ANY($1::uuid[])`, [metricIds]);
    await run(`DELETE FROM target_versions WHERE metric_id = ANY($1::uuid[])`, [metricIds]);
    await run(`DELETE FROM metrics WHERE id = ANY($1::uuid[])`, [metricIds]);
  }

  // Calendar.
  const eventIds = ids('event');
  if (eventIds.length) {
    await run(`DELETE FROM calendar_event_participants WHERE event_id = ANY($1::uuid[])`, [eventIds]);
    await run(`DELETE FROM jobs WHERE kind = 'event_reminder' AND payload->>'event_id' = ANY($1::text[])`, [eventIds]);
    await run(`DELETE FROM calendar_events WHERE id = ANY($1::uuid[])`, [eventIds]);
  }

  // Work: activity, attendance, sign-ins, projects (tasks, milestones, comments, updates cascade).
  await run(`DELETE FROM activity_log WHERE workspace_id = $1 AND payload->>'sim' = 'true'`, [ws.id]);
  await run(`DELETE FROM attendance_events WHERE workspace_id = $1 AND note = 'sim'`, [ws.id]);
  await run(`DELETE FROM auth_events WHERE workspace_id = $1 AND user_agent = 'sim'`, [ws.id]);
  if (projectIds.length) {
    await run(`DELETE FROM activity_log WHERE project_id = ANY($1::uuid[])`, [projectIds]);
    await run(
      `DELETE FROM notifications WHERE project_id = ANY($1::uuid[])
         OR task_id IN (SELECT id FROM tasks WHERE project_id = ANY($1::uuid[]))`,
      [projectIds],
    );
    await run(`DELETE FROM jobs WHERE kind = 'task_notify' AND payload->>'task_id' IN (SELECT id::text FROM tasks WHERE project_id = ANY($1::uuid[]))`, [projectIds]);
    await run(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  }

  // KPI goals and owners back to how they were.
  for (const g of of('kpi_goal')) {
    if (g.had_row) await run(`UPDATE kpi_goals SET target = NULL WHERE kpi_id = $1 AND how_often = $2`, [g.kpi_id, g.how_often]);
    else await run(`DELETE FROM kpi_goals WHERE kpi_id = $1 AND how_often = $2`, [g.kpi_id, g.how_often]);
  }
  for (const o of of('kpi_owner').reverse()) {
    await run(`UPDATE kpis SET owner_id = $2, owned_at_level = $3 WHERE id = $1`, [o.kpi_id, o.owner_id, o.owned_at_level]);
  }

  // Simulated staff and anything they touched afterwards.
  if (memberIds.length) {
    const m = [memberIds];
    await run(`DELETE FROM generated_reports WHERE requested_by = ANY($1::uuid[]) OR submitted_to = ANY($1::uuid[])`, m);
    await run(`DELETE FROM attendance_events WHERE membership_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM auth_events WHERE membership_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM activity_log WHERE actor_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM comments WHERE author_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM project_updates WHERE author_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM notifications WHERE membership_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM calendar_event_participants WHERE membership_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM submissions WHERE submitted_by = ANY($1::uuid[])`, m);
    await run(`UPDATE submissions SET validated_by = NULL WHERE validated_by = ANY($1::uuid[])`, m);
    await run(`DELETE FROM tasks WHERE created_by = ANY($1::uuid[])`, m);
    await run(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ANY($1::uuid[])`, m);
    await run(`UPDATE kpis SET owner_id = NULL WHERE owner_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM agent_tool_calls WHERE session_id IN (SELECT id FROM agent_sessions WHERE membership_id = ANY($1::uuid[]))`, m);
    await run(`DELETE FROM agent_sessions WHERE membership_id = ANY($1::uuid[])`, m);
    await run(`UPDATE memberships SET parent_id = NULL WHERE parent_id = ANY($1::uuid[])`, m);
    await run(`UPDATE assignments SET reports_to = NULL WHERE reports_to = ANY($1::uuid[])`, m);
    await run(`DELETE FROM assignments WHERE id = ANY($1::uuid[]) OR legacy_membership_id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM memberships WHERE id = ANY($1::uuid[])`, m);
    await run(`DELETE FROM workspace_members WHERE user_id = ANY($1::uuid[])`, [userIds]);
    await run(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  }

  // Team units (anything real still placed in them moves back to the organisation unit).
  if (unitIds.length) {
    await run(
      `UPDATE assignments a SET unit_id = u.parent_id FROM units u WHERE a.unit_id = u.id AND u.id = ANY($1::uuid[])`,
      [unitIds],
    );
    await run(`DELETE FROM project_units WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
    await run(`DELETE FROM units WHERE id = ANY($1::uuid[])`, [unitIds]);
  }

  await run(`DELETE FROM sim.registry WHERE workspace_id = $1`, [ws.id]);
  for (const t of tables) await run(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
}
