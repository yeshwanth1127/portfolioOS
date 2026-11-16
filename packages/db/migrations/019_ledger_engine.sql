-- Phase 6 — targets & measurement ledger (docs/BUILD.md §10).

CREATE TYPE aggregation AS ENUM ('sum', 'average', 'latest', 'ratio');

CREATE TABLE metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  unit_id uuid,
  project_id uuid,
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  unit_label text NOT NULL DEFAULT '',
  aggregation aggregation NOT NULL,
  direction direction NOT NULL DEFAULT 'higher_is_better',
  owner_id uuid,
  evidence_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  legacy_kpi_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, code),
  CHECK (num_nonnulls(unit_id, project_id) = 1),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX metrics_unit_idx ON metrics (workspace_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX metrics_project_idx ON metrics (workspace_id, project_id) WHERE project_id IS NOT NULL;

CREATE TABLE target_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  metric_id uuid NOT NULL,
  cadence how_often NOT NULL,
  goal numeric,
  range_low numeric,
  range_high numeric,
  watch_ratio numeric NOT NULL DEFAULT 0.8,
  progress_method text NOT NULL DEFAULT 'calendar_days'
    CHECK (progress_method IN ('calendar_days', 'working_days', 'checkpoints')),
  checkpoints jsonb,
  approval_required boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, metric_id) REFERENCES metrics (workspace_id, id),
  UNIQUE (metric_id, cadence, effective_from)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  metric_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  reporter_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (metric_id, period_start, period_end, reporter_id),
  FOREIGN KEY (workspace_id, metric_id) REFERENCES metrics (workspace_id, id),
  FOREIGN KEY (workspace_id, reporter_id) REFERENCES memberships (workspace_id, id),
  CHECK (period_end >= period_start)
);

CREATE TABLE report_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  report_id uuid NOT NULL,
  revision int NOT NULL CHECK (revision >= 1),
  value numeric,
  numerator numeric,
  denominator numeric,
  source_task_id uuid,
  evidence_url text,
  note text,
  channel text NOT NULL DEFAULT 'web',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes uuid,
  UNIQUE (workspace_id, id),
  UNIQUE (report_id, revision),
  FOREIGN KEY (workspace_id, report_id) REFERENCES reports (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes) REFERENCES report_revisions (workspace_id, id)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  report_revision_id uuid,
  task_id uuid,
  milestone_id uuid,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  revokes uuid,
  UNIQUE (workspace_id, id),
  CHECK (num_nonnulls(report_revision_id, task_id, milestone_id) = 1),
  UNIQUE (revokes),
  FOREIGN KEY (workspace_id, report_revision_id) REFERENCES report_revisions (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones (workspace_id, id),
  FOREIGN KEY (workspace_id, decided_by) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, revokes) REFERENCES approvals (workspace_id, id)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  metric_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quantity', 'observation', 'ratio')),
  quantity numeric,
  numerator numeric,
  denominator numeric,
  effective_on date NOT NULL,
  approval_id uuid NOT NULL,
  reverses uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (approval_id),
  UNIQUE (reverses),
  FOREIGN KEY (workspace_id, metric_id) REFERENCES metrics (workspace_id, id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals (workspace_id, id),
  FOREIGN KEY (workspace_id, reverses) REFERENCES ledger_entries (workspace_id, id)
);

CREATE INDEX ledger_entries_metric_period_idx
  ON ledger_entries (workspace_id, metric_id, effective_on);

CREATE TABLE ledger_source_claims (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  source_task_id uuid,
  source_milestone_id uuid,
  source_report_id uuid,
  entry_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(source_task_id, source_milestone_id, source_report_id) = 1),
  UNIQUE (source_task_id),
  UNIQUE (source_milestone_id),
  UNIQUE (source_report_id),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES ledger_entries (workspace_id, id),
  FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks (workspace_id, id),
  FOREIGN KEY (workspace_id, source_milestone_id) REFERENCES milestones (workspace_id, id),
  FOREIGN KEY (workspace_id, source_report_id) REFERENCES reports (workspace_id, id)
);

CREATE TABLE period_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  metric_id uuid NOT NULL,
  target_version_id uuid NOT NULL,
  cadence how_often NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  as_of date NOT NULL,
  revision int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  input_cutoff timestamptz NOT NULL,
  calc_version text NOT NULL,
  actual numeric,
  expected numeric,
  status text NOT NULL CHECK (status IN ('good', 'watch', 'bad', 'unscored', 'missing', 'overdue')),
  coverage numeric,
  inputs_hash text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (metric_id, cadence, period_start, as_of, revision),
  FOREIGN KEY (workspace_id, metric_id) REFERENCES metrics (workspace_id, id),
  FOREIGN KEY (workspace_id, target_version_id) REFERENCES target_versions (workspace_id, id)
);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  key text NOT NULL,
  route text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

ALTER TABLE tasks
  ADD COLUMN contributes_metric_id uuid,
  ADD COLUMN contributes_quantity numeric,
  ADD CONSTRAINT tasks_contributes_metric_fk
    FOREIGN KEY (workspace_id, contributes_metric_id) REFERENCES metrics (workspace_id, id);

ALTER TABLE milestones
  ADD COLUMN contributes_metric_id uuid,
  ADD COLUMN contributes_quantity numeric,
  ADD CONSTRAINT milestones_contributes_metric_fk
    FOREIGN KEY (workspace_id, contributes_metric_id) REFERENCES metrics (workspace_id, id);

-- Insert-only guard --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_insert_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'target_versions', 'report_revisions', 'approvals', 'ledger_entries', 'period_results'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_insert_only_mutation()',
      t, t
    );
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM portfolio_app', t);
  END LOOP;
END $$;

-- Row-level security -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'metrics', 'target_versions', 'reports', 'report_revisions', 'approvals',
    'ledger_entries', 'ledger_source_claims', 'period_results', 'idempotency_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

CREATE POLICY visible ON metrics FOR SELECT
  USING (
    app_global()
    OR unit_id IN (SELECT id FROM units)
    OR project_id IN (SELECT id FROM projects)
  );

CREATE POLICY mutate ON metrics FOR ALL
  USING (app_global() OR current_setting('app.role', true) = 'owner')
  WITH CHECK (app_global() OR current_setting('app.role', true) = 'owner');

CREATE POLICY visible ON target_versions FOR SELECT
  USING (metric_id IN (SELECT id FROM metrics));

CREATE POLICY insert ON target_versions FOR INSERT
  WITH CHECK (app_global() OR current_setting('app.role', true) = 'owner');

CREATE POLICY visible ON reports FOR SELECT
  USING (metric_id IN (SELECT id FROM metrics));

CREATE POLICY insert ON reports FOR INSERT
  WITH CHECK (
    reporter_id = app_membership()
    OR app_global()
    OR current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager', 'team_lead')
  );

CREATE POLICY visible ON report_revisions FOR SELECT
  USING (report_id IN (SELECT id FROM reports));

CREATE POLICY insert ON report_revisions FOR INSERT
  WITH CHECK (created_by = app_membership() OR app_global());

CREATE POLICY visible ON approvals FOR SELECT
  USING (true);

CREATE POLICY insert ON approvals FOR INSERT
  WITH CHECK (decided_by = app_membership() OR app_global());

CREATE POLICY visible ON ledger_entries FOR SELECT
  USING (metric_id IN (SELECT id FROM metrics));

CREATE POLICY insert ON ledger_entries FOR INSERT
  WITH CHECK (workspace_id = app_workspace());

CREATE POLICY visible ON ledger_source_claims FOR SELECT USING (true);

CREATE POLICY insert_claims ON ledger_source_claims FOR INSERT
  WITH CHECK (workspace_id = app_workspace());

CREATE POLICY delete_claims ON ledger_source_claims FOR DELETE
  USING (workspace_id = app_workspace());

CREATE POLICY visible ON period_results FOR SELECT
  USING (metric_id IN (SELECT id FROM metrics));

CREATE POLICY insert ON period_results FOR INSERT
  WITH CHECK (workspace_id = app_workspace() OR app_global());

CREATE POLICY visible ON idempotency_keys FOR SELECT
  USING (true);

CREATE POLICY insert ON idempotency_keys FOR INSERT
  WITH CHECK (workspace_id = app_workspace());
