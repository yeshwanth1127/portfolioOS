-- Phase 9 — expansion (dependencies, templates, attachments, saved views, calendar, billing stubs).

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate_hours numeric(8, 2) CHECK (estimate_hours IS NULL OR estimate_hours >= 0);

CREATE TABLE task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  predecessor_id uuid NOT NULL,
  successor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, predecessor_id, successor_id),
  FOREIGN KEY (workspace_id, predecessor_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, successor_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CHECK (predecessor_id <> successor_id)
);

CREATE INDEX task_dependencies_succ_idx ON task_dependencies (workspace_id, successor_id);
CREATE INDEX task_dependencies_pred_idx ON task_dependencies (workspace_id, predecessor_id);

CREATE TABLE project_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX project_templates_ws_idx ON project_templates (workspace_id, lower(name));

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  entity_type text NOT NULL CHECK (entity_type IN ('task', 'project')),
  entity_id uuid NOT NULL,
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_key text NOT NULL CHECK (length(trim(storage_key)) BETWEEN 1 AND 500),
  byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, uploaded_by) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX attachments_entity_idx ON attachments (workspace_id, entity_type, entity_id);

CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  route text NOT NULL CHECK (length(trim(route)) BETWEEN 1 AND 200),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX saved_views_user_idx ON saved_views (workspace_id, user_id);

CREATE TYPE calendar_provider AS ENUM ('google', 'outlook');

CREATE TABLE calendar_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  provider calendar_provider NOT NULL,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider),
  UNIQUE (workspace_id, id)
);

CREATE TABLE calendar_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  provider calendar_provider NOT NULL,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'skipped', 'error')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE billing_customers (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  stripe_customer_id text,
  subscription_status text NOT NULL DEFAULT 'none'
    CHECK (subscription_status IN ('none', 'trialing', 'active', 'past_due', 'canceled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Cycle detection: reject edge if successor can already reach predecessor.
CREATE OR REPLACE FUNCTION auth.task_dependency_blocks_cycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reach AS (
      SELECT NEW.successor_id AS task_id
      UNION
      SELECT d.successor_id
      FROM task_dependencies d
      JOIN reach r ON d.predecessor_id = r.task_id
      WHERE d.workspace_id = NEW.workspace_id
    )
    SELECT 1 FROM reach WHERE task_id = NEW.predecessor_id
  ) THEN
    RAISE EXCEPTION 'dependency_cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_dependencies_no_cycle
  BEFORE INSERT ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION auth.task_dependency_blocks_cycle();

CREATE OR REPLACE FUNCTION auth.seed_default_project_template()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO project_templates (workspace_id, name, payload)
  VALUES (
    NEW.id,
    'Standard delivery',
    jsonb_build_object(
      'project', jsonb_build_object('status', 'planned', 'priority', 'normal'),
      'tasks', jsonb_build_array(
        jsonb_build_object('title', 'Kickoff'),
        jsonb_build_object('title', 'Delivery'),
        jsonb_build_object('title', 'Retrospective')
      )
    )
  );
  INSERT INTO billing_customers (workspace_id) VALUES (NEW.id)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_expansion_defaults
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION auth.seed_default_project_template();

INSERT INTO project_templates (workspace_id, name, payload)
SELECT w.id, 'Standard delivery',
  jsonb_build_object(
    'project', jsonb_build_object('status', 'planned', 'priority', 'normal'),
    'tasks', jsonb_build_array(
      jsonb_build_object('title', 'Kickoff'),
      jsonb_build_object('title', 'Delivery'),
      jsonb_build_object('title', 'Retrospective')
    )
  )
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM project_templates pt WHERE pt.workspace_id = w.id AND pt.name = 'Standard delivery'
);

INSERT INTO billing_customers (workspace_id)
SELECT w.id FROM workspaces w
ON CONFLICT (workspace_id) DO NOTHING;

UPDATE plans SET features = '["agent","whatsapp","projects","ledger","dashboards","export","onboarding","portability","billing","calendar_sync"]'::jsonb
WHERE code = 'pilot';

-- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'task_dependencies', 'project_templates', 'attachments', 'saved_views',
    'calendar_integrations', 'calendar_sync_log', 'billing_customers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

CREATE POLICY visible ON task_dependencies
  FOR ALL
  USING (
    app_global()
    OR predecessor_id IN (SELECT id FROM tasks)
    OR successor_id IN (SELECT id FROM tasks)
  )
  WITH CHECK (
    app_global()
    OR (predecessor_id IN (SELECT id FROM tasks) AND successor_id IN (SELECT id FROM tasks))
  );

CREATE POLICY templates_read ON project_templates
  FOR SELECT
  USING (app_global() OR workspace_id = app_workspace());

CREATE POLICY templates_write ON project_templates
  FOR INSERT
  WITH CHECK (
    app_global()
    OR current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager')
  );

CREATE POLICY templates_update ON project_templates
  FOR UPDATE
  USING (app_global() OR current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager'))
  WITH CHECK (app_global() OR current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager'));

CREATE POLICY templates_delete ON project_templates
  FOR DELETE
  USING (app_global() OR current_setting('app.role', true) = 'owner');

CREATE POLICY visible ON attachments
  FOR ALL
  USING (
    app_global()
    OR (entity_type = 'project' AND entity_id IN (SELECT id FROM projects))
    OR (entity_type = 'task' AND entity_id IN (SELECT id FROM tasks))
  )
  WITH CHECK (
    app_global()
    OR uploaded_by = app_membership()
  );

CREATE POLICY visible ON saved_views
  FOR ALL
  USING (app_global() OR user_id = app_membership())
  WITH CHECK (app_global() OR user_id = app_membership());

CREATE POLICY visible ON calendar_integrations
  FOR SELECT
  USING (app_global() OR workspace_id = app_workspace());

CREATE POLICY calendar_owner ON calendar_integrations
  FOR ALL
  USING (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'))
  WITH CHECK (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'));

CREATE POLICY sync_log_read ON calendar_sync_log
  FOR SELECT
  USING (app_global() OR workspace_id = app_workspace());

CREATE POLICY sync_log_system ON calendar_sync_log
  FOR INSERT
  WITH CHECK (app_global() OR current_setting('app.role', true) = 'system');

CREATE POLICY billing_read ON billing_customers
  FOR SELECT
  USING (app_global() OR workspace_id = app_workspace());

CREATE POLICY billing_owner ON billing_customers
  FOR ALL
  USING (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) = 'owner'))
  WITH CHECK (app_global() OR (workspace_id = app_workspace() AND current_setting('app.role', true) IN ('owner', 'system')));
