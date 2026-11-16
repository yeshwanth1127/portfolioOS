-- Workspaces: a hard customer boundary above organisations (docs/BUILD.md § 6).
--
-- 1. workspaces + workspace_members (+ WhatsApp connections owned by a workspace)
-- 2. workspace_id on every business table; existing rows move into a "Sona" workspace
-- 3. composite foreign keys (workspace_id, x_id) → (workspace_id, id): foreign-key checks bypass
--    row-level security, so only the key itself can stop a row pointing into another workspace
-- 4. a RESTRICTIVE isolation policy on every workspace table (AND-ed with the access policies,
--    so the owner role never sees across workspaces)

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  currency char(3) NOT NULL DEFAULT 'INR',
  plan text NOT NULL DEFAULT 'pilot',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_role text NOT NULL DEFAULT 'member' CHECK (workspace_role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connector_id text NOT NULL UNIQUE,
  linked_phone_e164 text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'logged_out')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE FUNCTION app_workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

DO $$
DECLARE
  ws uuid;
  t text;
  tables text[] := ARRAY[
    'organisations', 'memberships', 'revenue_lines', 'kpis', 'kpi_goals', 'kpi_audit',
    'activity_entries', 'submissions', 'signoffs', 'org_periods', 'scores', 'amendments',
    'profile_sections', 'case_studies', 'partnerships', 'org_links', 'escalations',
    'agent_sessions', 'agent_tool_calls', 'agent_pending_confirms', 'wa_outbox'
  ];
  with_id text[] := ARRAY[
    'organisations', 'memberships', 'revenue_lines', 'kpis', 'kpi_audit', 'activity_entries',
    'submissions', 'signoffs', 'scores', 'amendments', 'profile_sections', 'case_studies',
    'partnerships', 'org_links', 'escalations', 'agent_sessions', 'agent_tool_calls',
    'agent_pending_confirms', 'wa_outbox'
  ];
  fk record;
  action text;
BEGIN
  -- Existing data becomes the Sona workspace.
  IF EXISTS (SELECT 1 FROM organisations) OR EXISTS (SELECT 1 FROM memberships) THEN
    INSERT INTO workspaces (name, slug) VALUES ('Sona', 'sona') RETURNING id INTO ws;
    INSERT INTO workspace_members (workspace_id, user_id, workspace_role)
    SELECT ws, m.user_id,
           CASE WHEN bool_or(m.role = 'owner') THEN 'owner' ELSE 'member' END
    FROM memberships m GROUP BY m.user_id;
  END IF;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN workspace_id uuid REFERENCES workspaces(id)', t);
    IF ws IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET workspace_id = $1', t) USING ws;
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET NOT NULL', t);
    -- New rows land in the caller's workspace unless one is given explicitly.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET DEFAULT app_workspace()', t);
    EXECUTE format('CREATE INDEX %I ON %I (workspace_id)', t || '_workspace_idx', t);
  END LOOP;

  FOREACH t IN ARRAY with_id LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (workspace_id, id)', t, t || '_ws_id_key');
  END LOOP;

  -- Every single-column FK between two workspace tables becomes (workspace_id, col) → (workspace_id, id).
  FOR fk IN
    SELECT c.conname, src.relname AS src, a.attname AS col, ref.relname AS ref, c.confdeltype
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
      AND src.relnamespace = 'public'::regnamespace
      AND src.relname = ANY (tables) AND ref.relname = ANY (with_id)
  LOOP
    action := CASE fk.confdeltype WHEN 'c' THEN ' ON DELETE CASCADE' WHEN 'n' THEN ' ON DELETE SET NULL (' || quote_ident(fk.col) || ')' ELSE '' END;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.src, fk.conname);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id, %I) REFERENCES %I (workspace_id, id)%s',
      fk.src, fk.conname, fk.col, fk.ref, action
    );
  END LOOP;
END $$;

ALTER TABLE workspace_members ALTER COLUMN workspace_id SET DEFAULT app_workspace();
ALTER TABLE whatsapp_connections ALTER COLUMN workspace_id SET DEFAULT app_workspace();

-- kpi_goals has no id: its parent link is (workspace_id, kpi_id).
-- Memberships belong to workspace members.
ALTER TABLE memberships ADD CONSTRAINT memberships_workspace_member_fk
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id);

-- Organisation slugs are unique per workspace, not globally.
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_slug_key;
ALTER TABLE organisations ADD CONSTRAINT organisations_ws_slug_key UNIQUE (workspace_id, slug);

-- Row-level security -------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organisations', 'memberships', 'revenue_lines', 'kpis', 'kpi_goals', 'kpi_audit',
    'activity_entries', 'submissions', 'signoffs', 'org_periods', 'scores', 'amendments',
    'profile_sections', 'case_studies', 'partnerships', 'org_links', 'escalations',
    'agent_sessions', 'agent_tool_calls', 'agent_pending_confirms', 'wa_outbox',
    'workspace_members', 'whatsapp_connections'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

-- Tables that had no access policy yet: everything inside the workspace (isolation does the rest).
CREATE POLICY ws_access ON organisations USING (true);
CREATE POLICY ws_access ON revenue_lines USING (true);
CREATE POLICY ws_access ON profile_sections USING (true);
CREATE POLICY ws_access ON case_studies USING (true);
CREATE POLICY ws_access ON partnerships USING (true);
CREATE POLICY ws_access ON org_links USING (true);
CREATE POLICY ws_access ON workspace_members USING (true);
CREATE POLICY ws_access ON whatsapp_connections USING (true);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY own_workspace ON workspaces USING (id = app_workspace());

-- Auth bootstrap functions, workspace-aware --------------------------------------------------
DROP FUNCTION auth.actor_for_membership(uuid);
CREATE FUNCTION auth.actor_for_membership(p_membership_id uuid)
RETURNS TABLE (
  id uuid, role role_level, org_id uuid, user_id uuid, title text, state member_state, parent_id uuid,
  full_name text, email text, phone_e164 text, is_named boolean,
  org_slug text, org_short_name text, org_name text,
  reports_to_name text, reports_to_role role_level, reports_to_title text,
  workspace_id uuid, workspace_name text, workspace_slug text, workspace_timezone text, workspace_role text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.role, m.org_id, m.user_id, m.title, m.state, m.parent_id,
         u.full_name, u.email, u.phone_e164, u.is_named,
         o.slug, o.short_name, o.name,
         pu.full_name, pm.role, pm.title,
         w.id, w.name, w.slug, w.timezone, wm.workspace_role
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  JOIN workspaces w ON w.id = m.workspace_id AND w.status = 'active'
  JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = m.user_id AND wm.status = 'active'
  LEFT JOIN organisations o ON o.id = m.org_id
  LEFT JOIN memberships pm ON pm.id = m.parent_id
  LEFT JOIN users pu ON pu.id = pm.user_id
  WHERE m.id = p_membership_id AND m.state <> 'inactive' AND u.status = 'active'
$$;

-- The membership a user signs in with, optionally in a given workspace.
DROP FUNCTION auth.primary_membership(uuid);
CREATE FUNCTION auth.primary_membership(p_user_id uuid, p_workspace_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id FROM memberships m
  JOIN workspaces w ON w.id = m.workspace_id AND w.status = 'active'
  JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = m.user_id AND wm.status = 'active'
  WHERE m.user_id = p_user_id AND m.state <> 'inactive'
    AND (p_workspace_id IS NULL OR m.workspace_id = p_workspace_id)
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'vice_manager' THEN 2
                       WHEN 'team_lead' THEN 3 ELSE 4 END, w.created_at, m.created_at
  LIMIT 1
$$;

CREATE FUNCTION auth.workspaces_for_user(p_user_id uuid)
RETURNS TABLE (workspace_id uuid, name text, slug text, workspace_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.name, w.slug, wm.workspace_role
  FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
  WHERE wm.user_id = p_user_id AND wm.status = 'active' AND w.status = 'active'
  ORDER BY w.created_at
$$;

-- WhatsApp is per workspace: a phone resolves only within the connection's workspace.
DROP FUNCTION auth.actor_for_phone(text);
CREATE FUNCTION auth.actor_for_phone(p_connector_id text, p_phone text)
RETURNS TABLE (membership_id uuid, role role_level, full_name text, phone_e164 text, org_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.role, u.full_name, u.phone_e164, m.org_id, m.workspace_id
  FROM whatsapp_connections wc
  JOIN memberships m ON m.workspace_id = wc.workspace_id
  JOIN users u ON u.id = m.user_id
  WHERE wc.connector_id = p_connector_id
    AND regexp_replace(coalesce(u.phone_e164, ''), '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
    AND regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    AND m.state <> 'inactive' AND u.status = 'active'
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'vice_manager' THEN 2
                       WHEN 'team_lead' THEN 3 ELSE 4 END
  LIMIT 1
$$;

DROP FUNCTION auth.registered_phones();
CREATE FUNCTION auth.registered_phones(p_connector_id text)
RETURNS TABLE (phone_e164 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.phone_e164
  FROM whatsapp_connections wc
  JOIN memberships m ON m.workspace_id = wc.workspace_id
  JOIN users u ON u.id = m.user_id
  WHERE wc.connector_id = p_connector_id
    AND u.phone_e164 IS NOT NULL AND u.phone_e164 <> '' AND m.state <> 'inactive' AND u.status = 'active'
$$;

CREATE FUNCTION auth.workspace_for_connector(p_connector_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT workspace_id FROM whatsapp_connections WHERE connector_id = p_connector_id
$$;

CREATE FUNCTION auth.active_workspaces()
RETURNS TABLE (workspace_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, timezone FROM workspaces WHERE status = 'active' ORDER BY created_at
$$;
