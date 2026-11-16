-- Enforced row-level security (docs/BUILD.md § 4.13).
-- The API connects as portfolio_app (no BYPASSRLS) and every request sets app.role / app.org_id /
-- app.membership_id in its transaction. FORCE applies the policies to the table owner too.
--
-- Scope rules (Phase 0, single portfolio): the owner and the internal 'system' actor (digest,
-- WhatsApp outbox) see every organisation; everyone else sees their own organisation.
-- Phase 2 adds a restrictive workspace policy on top of these.

CREATE FUNCTION app_global() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.role', true), '') IN ('owner', 'system')
$$;
CREATE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
CREATE FUNCTION app_membership() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.membership_id', true), '')::uuid
$$;

-- Organisation-scoped tables -----------------------------------------------------------------
DROP POLICY IF EXISTS org_scope_submissions ON submissions;
DROP POLICY IF EXISTS org_scope_kpis ON kpis;
DROP POLICY IF EXISTS org_scope_scores ON scores;
DROP POLICY IF EXISTS org_scope_org_periods ON org_periods;

CREATE POLICY org_scope ON submissions USING (app_global() OR org_id = app_org());
CREATE POLICY org_scope ON kpis USING (app_global() OR org_id = app_org());
CREATE POLICY org_scope ON scores USING (app_global() OR org_id = app_org());
CREATE POLICY org_scope ON org_periods USING (app_global() OR org_id = app_org());
CREATE POLICY org_scope ON signoffs USING (app_global() OR org_id = app_org());
CREATE POLICY org_scope ON escalations USING (app_global() OR org_id = app_org());

-- A person sees their organisation's roster and their own membership.
CREATE POLICY org_scope ON memberships USING (app_global() OR org_id = app_org() OR id = app_membership());

-- Rows that belong to a KPI or submission follow that row's visibility.
CREATE POLICY via_kpi ON kpi_goals USING (kpi_id IN (SELECT id FROM kpis));
CREATE POLICY via_kpi ON kpi_audit USING (kpi_id IN (SELECT id FROM kpis));
CREATE POLICY via_submission ON amendments USING (submission_id IN (SELECT id FROM submissions));

-- activity_entries: keep the reporting-subtree rule, add the system actor.
DROP POLICY IF EXISTS subtree_scope_activity ON activity_entries;
CREATE POLICY subtree_scope ON activity_entries USING (
  app_global()
  OR (org_id = app_org() AND current_setting('app.role', true) IN ('manager', 'vice_manager', 'team_lead'))
  OR membership_id IN (
    WITH RECURSIVE sub AS (
      SELECT id FROM memberships WHERE id = app_membership()
      UNION ALL
      SELECT m.id FROM memberships m JOIN sub ON m.parent_id = sub.id
    )
    SELECT id FROM sub
  )
);

-- Agent and WhatsApp tables ------------------------------------------------------------------
CREATE POLICY own_sessions ON agent_sessions
  USING (membership_id = app_membership() OR current_setting('app.role', true) = 'system');
CREATE POLICY own_confirms ON agent_pending_confirms
  USING (membership_id = app_membership() OR current_setting('app.role', true) = 'system');

-- Tool-call log: anyone may append (it is written on its own connection so it survives a
-- rolled-back action); only the owner and system read it.
CREATE POLICY append ON agent_tool_calls FOR INSERT WITH CHECK (true);
CREATE POLICY read_global ON agent_tool_calls FOR SELECT USING (app_global());

-- Outbox: the API queues messages; only the system actor (gateway) and owner read/update them.
CREATE POLICY append ON wa_outbox FOR INSERT WITH CHECK (true);
CREATE POLICY read_global ON wa_outbox FOR SELECT USING (app_global());
CREATE POLICY update_system ON wa_outbox FOR UPDATE USING (current_setting('app.role', true) = 'system');
CREATE POLICY system_only ON wa_auth_state USING (current_setting('app.role', true) = 'system');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'submissions', 'kpis', 'scores', 'org_periods', 'signoffs', 'escalations', 'memberships',
    'kpi_goals', 'kpi_audit', 'amendments', 'activity_entries', 'agent_sessions',
    'agent_pending_confirms', 'agent_tool_calls', 'wa_outbox', 'wa_auth_state'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
