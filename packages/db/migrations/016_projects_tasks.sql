-- Phase 5 slice 5.0 — projects and tasks (docs/BUILD.md §9).

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  unit_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description text,
  manager_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'on_hold', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  starts_on date,
  due_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, manager_id) REFERENCES memberships (workspace_id, id),
  CHECK (due_on IS NULL OR starts_on IS NULL OR due_on >= starts_on)
);

CREATE INDEX projects_unit_idx ON projects (workspace_id, unit_id);
CREATE INDEX projects_manager_idx ON projects (workspace_id, manager_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  description text,
  assignee_id uuid,
  status text NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_on date,
  position numeric NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, assignee_id) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX tasks_project_idx ON tasks (workspace_id, project_id, position);
CREATE INDEX tasks_assignee_idx ON tasks (workspace_id, assignee_id)
  WHERE assignee_id IS NOT NULL AND status NOT IN ('done', 'cancelled');

ALTER TABLE assignments
  ADD CONSTRAINT assignments_project_fk
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id);

-- Row-level security -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

CREATE POLICY visible ON projects
  USING (
    app_global()
    OR manager_id = app_membership()
    OR unit_id IN (SELECT id FROM units WHERE legacy_org_id = app_org())
  )
  WITH CHECK (
    app_global()
    OR manager_id = app_membership()
    OR unit_id IN (SELECT id FROM units WHERE legacy_org_id = app_org())
  );

CREATE POLICY visible ON tasks
  USING (
    app_global()
    OR assignee_id = app_membership()
    OR created_by = app_membership()
    OR project_id IN (SELECT id FROM projects)
  )
  WITH CHECK (
    app_global()
    OR assignee_id = app_membership()
    OR created_by = app_membership()
    OR project_id IN (SELECT id FROM projects)
  );
