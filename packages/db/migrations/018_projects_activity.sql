-- Phase 5 slice 5.2 — comments, project updates, activity log, project health (docs/BUILD.md §9).

ALTER TABLE projects
  ADD COLUMN health_override text
    CHECK (health_override IS NULL OR health_override IN ('on_track', 'at_risk', 'off_track')),
  ADD COLUMN health_reason text,
  ADD COLUMN health_set_by uuid,
  ADD COLUMN health_set_at timestamptz,
  ADD CONSTRAINT projects_health_override_reason
    CHECK ((health_override IS NULL) = (health_reason IS NULL));

ALTER TABLE projects
  ADD CONSTRAINT projects_health_set_by_fk
  FOREIGN KEY (workspace_id, health_set_by) REFERENCES memberships (workspace_id, id);

ALTER TABLE tasks
  ADD COLUMN milestone_id uuid,
  ADD CONSTRAINT tasks_milestone_fk
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones (workspace_id, id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION check_task_milestone_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.milestone_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM milestones m
      WHERE m.id = NEW.milestone_id
        AND m.workspace_id = NEW.workspace_id
        AND m.project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'milestone must belong to the task''s project';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_milestone_project
  BEFORE INSERT OR UPDATE OF milestone_id, project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION check_task_milestone_project();

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  project_id uuid,
  task_id uuid,
  milestone_id uuid,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  CHECK (num_nonnulls(project_id, task_id, milestone_id) = 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, author_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX comments_task_idx ON comments (workspace_id, task_id, created_at DESC)
  WHERE task_id IS NOT NULL;
CREATE INDEX comments_project_idx ON comments (workspace_id, project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE TABLE project_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, author_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX project_updates_project_idx ON project_updates (workspace_id, project_id, created_at DESC);

CREATE TABLE activity_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  actor_id uuid NOT NULL,
  project_id uuid,
  task_id uuid,
  kind text NOT NULL CHECK (length(trim(kind)) BETWEEN 1 AND 80),
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX activity_log_project_idx ON activity_log (workspace_id, project_id, at DESC)
  WHERE project_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_activity_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is insert-only';
END;
$$;

CREATE TRIGGER activity_log_immutable
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION reject_activity_log_mutation();

REVOKE UPDATE, DELETE ON activity_log FROM portfolio_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comments', 'project_updates', 'activity_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

CREATE POLICY visible ON comments
  USING (
    app_global()
    OR author_id = app_membership()
    OR (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects))
    OR (task_id IS NOT NULL AND task_id IN (SELECT id FROM tasks))
    OR (milestone_id IS NOT NULL AND milestone_id IN (SELECT id FROM milestones))
  )
  WITH CHECK (
    app_global()
    OR author_id = app_membership()
    OR (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects))
    OR (task_id IS NOT NULL AND task_id IN (SELECT id FROM tasks))
    OR (milestone_id IS NOT NULL AND milestone_id IN (SELECT id FROM milestones))
  );

CREATE POLICY visible ON project_updates
  USING (project_id IN (SELECT id FROM projects))
  WITH CHECK (project_id IN (SELECT id FROM projects));

CREATE POLICY visible ON activity_log
  FOR SELECT
  USING (
    app_global()
    OR (project_id IS NOT NULL AND project_id IN (SELECT id FROM projects))
    OR (task_id IS NOT NULL AND task_id IN (SELECT id FROM tasks))
  );

CREATE POLICY insert_scope ON activity_log
  FOR INSERT
  WITH CHECK (actor_id = app_membership() OR app_global());
