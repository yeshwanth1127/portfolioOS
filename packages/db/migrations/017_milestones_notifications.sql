-- Phase 5 slice 5.1 — milestones, project_units, in-app notifications (docs/BUILD.md §9).

CREATE TABLE project_units (
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'participant'
    CHECK (role IN ('primary', 'participant')),
  PRIMARY KEY (project_id, unit_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id)
);

CREATE TABLE milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  due_on date,
  owner_id uuid,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX milestones_project_idx ON milestones (workspace_id, project_id);
CREATE INDEX milestones_owner_due_idx ON milestones (workspace_id, owner_id, due_on)
  WHERE owner_id IS NOT NULL AND status = 'open';

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  membership_id uuid NOT NULL,
  kind text NOT NULL,
  task_id uuid,
  project_id uuid,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 500),
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'whatsapp')),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX notifications_member_idx ON notifications (workspace_id, membership_id, created_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_units', 'milestones', 'notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

CREATE POLICY visible ON project_units
  USING (project_id IN (SELECT id FROM projects))
  WITH CHECK (project_id IN (SELECT id FROM projects));

CREATE POLICY visible ON milestones
  USING (
    app_global()
    OR owner_id = app_membership()
    OR project_id IN (SELECT id FROM projects)
  )
  WITH CHECK (
    app_global()
    OR owner_id = app_membership()
    OR project_id IN (SELECT id FROM projects)
  );

CREATE POLICY mine ON notifications
  USING (app_global() OR membership_id = app_membership())
  WITH CHECK (membership_id = app_membership() OR app_global());
