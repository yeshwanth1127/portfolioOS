-- Phase 8 — commercial pilot (plans, entitlements, usage, portability).

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL,
  features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array')
);

INSERT INTO plans (code, name, features) VALUES
  ('pilot', 'Pilot', '["agent","whatsapp","projects","ledger","dashboards","export","onboarding","portability"]'::jsonb),
  ('limited', 'Limited (test)', '["dashboards"]'::jsonb);

CREATE TABLE workspace_entitlements (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX workspace_entitlements_plan_idx ON workspace_entitlements (plan_id);

-- Backfill every workspace with the pilot plan.
INSERT INTO workspace_entitlements (workspace_id, plan_id)
SELECT w.id, p.id FROM workspaces w CROSS JOIN plans p WHERE p.code = 'pilot'
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE workspace_usage_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  day date NOT NULL,
  active_users int NOT NULL DEFAULT 0,
  agent_tool_calls int NOT NULL DEFAULT 0,
  wa_messages int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);

CREATE TABLE workspace_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  storage_path text,
  manifest jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id)
);

CREATE INDEX workspace_export_jobs_status_idx ON workspace_export_jobs (workspace_id, status);

CREATE TABLE workspace_deletion_requests (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  grace_period_ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  FOREIGN KEY (workspace_id, requested_by) REFERENCES memberships (workspace_id, id)
);

-- Default entitlement for new workspaces.
CREATE FUNCTION auth.grant_pilot_entitlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE pid uuid;
BEGIN
  SELECT id INTO pid FROM plans WHERE code = 'pilot';
  IF pid IS NOT NULL THEN
    INSERT INTO workspace_entitlements (workspace_id, plan_id) VALUES (NEW.id, pid)
    ON CONFLICT (workspace_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_grant_pilot
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION auth.grant_pilot_entitlement();

-- Usage counters (definer: called from API / jobs without extra grants).
CREATE FUNCTION auth.bump_usage(p_workspace_id uuid, p_day date, p_metric text, p_delta int DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_metric NOT IN ('active_users', 'agent_tool_calls', 'wa_messages') THEN
    RAISE EXCEPTION 'unknown usage metric %', p_metric;
  END IF;
  INSERT INTO workspace_usage_daily (workspace_id, day, active_users, agent_tool_calls, wa_messages)
  VALUES (
    p_workspace_id,
    p_day,
    CASE WHEN p_metric = 'active_users' THEN p_delta ELSE 0 END,
    CASE WHEN p_metric = 'agent_tool_calls' THEN p_delta ELSE 0 END,
    CASE WHEN p_metric = 'wa_messages' THEN p_delta ELSE 0 END
  )
  ON CONFLICT (workspace_id, day) DO UPDATE SET
    active_users = workspace_usage_daily.active_users
      + CASE WHEN p_metric = 'active_users' THEN p_delta ELSE 0 END,
    agent_tool_calls = workspace_usage_daily.agent_tool_calls
      + CASE WHEN p_metric = 'agent_tool_calls' THEN p_delta ELSE 0 END,
    wa_messages = workspace_usage_daily.wa_messages
      + CASE WHEN p_metric = 'wa_messages' THEN p_delta ELSE 0 END,
    updated_at = now();
END;
$$;

CREATE FUNCTION auth.workspace_plan_features(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT p.features
     FROM workspace_entitlements we
     JOIN plans p ON p.id = we.plan_id
     WHERE we.workspace_id = p_workspace_id
       AND (we.expires_at IS NULL OR we.expires_at > now())),
    '[]'::jsonb
  );
$$;

-- Membership bootstrap includes plan metadata for API feature gates.
DROP FUNCTION auth.actor_for_membership(uuid);
CREATE FUNCTION auth.actor_for_membership(p_membership_id uuid)
RETURNS TABLE (
  id uuid, role role_level, org_id uuid, user_id uuid, title text, state member_state, parent_id uuid,
  full_name text, email text, phone_e164 text, is_named boolean,
  org_slug text, org_short_name text, org_name text,
  reports_to_name text, reports_to_role role_level, reports_to_title text,
  workspace_id uuid, workspace_name text, workspace_slug text, workspace_timezone text, workspace_role text,
  plan_code text, plan_features jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.role, m.org_id, m.user_id, m.title, m.state, m.parent_id,
         u.full_name, u.email, u.phone_e164, u.is_named,
         o.slug, o.short_name, o.name,
         pu.full_name, pm.role, pm.title,
         w.id, w.name, w.slug, w.timezone, wm.workspace_role,
         p.code,
         p.features
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  JOIN workspaces w ON w.id = m.workspace_id AND w.status = 'active'
  JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = m.user_id AND wm.status = 'active'
  LEFT JOIN organisations o ON o.id = m.org_id
  LEFT JOIN memberships pm ON pm.id = m.parent_id
  LEFT JOIN users pu ON pu.id = pm.user_id
  LEFT JOIN workspace_entitlements we ON we.workspace_id = w.id
    AND (we.expires_at IS NULL OR we.expires_at > now())
  LEFT JOIN plans p ON p.id = we.plan_id
  WHERE m.id = p_membership_id AND m.state <> 'inactive' AND u.status = 'active'
$$;

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'plans', 'workspace_entitlements', 'workspace_usage_daily',
    'workspace_export_jobs', 'workspace_deletion_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF t = 'plans' THEN
      EXECUTE 'CREATE POLICY plans_read ON plans FOR SELECT USING (true)';
    ELSIF t = 'workspace_entitlements' THEN
      EXECUTE format(
        'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
        t
      );
      EXECUTE format('CREATE POLICY entitlements_read ON %I FOR SELECT USING (app_global() OR workspace_id = app_workspace())', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
        t
      );
      EXECUTE format(
        'CREATE POLICY workspace_visible ON %I FOR SELECT USING (app_global() OR workspace_id = app_workspace())',
        t
      );
    END IF;
  END LOOP;
END $$;

CREATE POLICY export_jobs_insert ON workspace_export_jobs FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner');
CREATE POLICY export_jobs_select ON workspace_export_jobs FOR SELECT
  USING (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'));
CREATE POLICY export_jobs_update ON workspace_export_jobs FOR UPDATE
  USING (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'))
  WITH CHECK (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'));

CREATE POLICY deletion_owner ON workspace_deletion_requests FOR ALL
  USING (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'))
  WITH CHECK (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'));

CREATE FUNCTION auth.set_workspace_entitlement(
  p_workspace_id uuid,
  p_plan_code text,
  p_expires_at timestamptz DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE pid uuid;
BEGIN
  IF p_workspace_id IS DISTINCT FROM app_workspace() AND NOT app_global() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT id INTO pid FROM plans WHERE code = p_plan_code;
  IF pid IS NULL THEN RAISE EXCEPTION 'unknown plan %', p_plan_code; END IF;
  INSERT INTO workspace_entitlements (workspace_id, plan_id, granted_at, expires_at, metadata)
  VALUES (p_workspace_id, pid, now(), p_expires_at, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (workspace_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id,
    granted_at = now(),
    expires_at = EXCLUDED.expires_at,
    metadata = EXCLUDED.metadata;
END;
$$;

GRANT SELECT ON plans TO portfolio_app;
REVOKE ALL ON workspace_entitlements FROM portfolio_app;
GRANT SELECT ON workspace_entitlements TO portfolio_app;
GRANT SELECT ON workspace_usage_daily TO portfolio_app;
GRANT SELECT, INSERT, UPDATE ON workspace_export_jobs TO portfolio_app;
GRANT SELECT, INSERT, UPDATE ON workspace_deletion_requests TO portfolio_app;
