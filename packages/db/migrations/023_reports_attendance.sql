-- Reports section: generated reports (agent-drafted, server-computed figures), attendance
-- (explicit clock in / out) and sign-in events. docs/REPORTS.md.

-- Generated reports -------------------------------------------------------------------------
-- `datasets` holds every figure the report shows, computed by the API from live tables.
-- `spec` is the layout (tiles, charts, tables) plus the narrative; the narrative may only
-- quote numbers that appear in `datasets` (checked in packages/api/src/modules/reports).
CREATE TABLE generated_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  requested_by uuid NOT NULL,
  report_type text NOT NULL CHECK (length(trim(report_type)) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  scope_kind text NOT NULL CHECK (scope_kind IN ('workspace', 'org', 'team', 'person', 'me')),
  scope_ref uuid,
  scope_label text NOT NULL DEFAULT '',
  period_from date NOT NULL,
  period_to date NOT NULL,
  instructions text CHECK (instructions IS NULL OR length(instructions) <= 1000),
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'whatsapp', 'agent')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  narrative_source text CHECK (narrative_source IS NULL OR narrative_source IN ('agent', 'template')),
  datasets jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(datasets) = 'object'),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(spec) = 'object'),
  error text,
  submitted_to uuid,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (period_from <= period_to),
  CHECK ((submitted_to IS NULL) = (submitted_at IS NULL)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, requested_by) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, submitted_to) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX generated_reports_requester_idx ON generated_reports (workspace_id, requested_by, created_at DESC);
CREATE INDEX generated_reports_submitted_idx ON generated_reports (workspace_id, submitted_to, submitted_at DESC)
  WHERE submitted_to IS NOT NULL;

-- Attendance ----------------------------------------------------------------------------------
-- Insert-only clock events. A day's hours are the sum of in→out pairs; an "in" with no
-- later "out" that day is reported as missing a clock-out, never guessed.
CREATE TABLE attendance_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('in', 'out')),
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'whatsapp', 'agent')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX attendance_events_member_idx ON attendance_events (workspace_id, membership_id, at DESC);
CREATE INDEX attendance_events_at_idx ON attendance_events (workspace_id, at);

-- Sign-in events --------------------------------------------------------------------------------
-- Written by auth.record_auth_event (login runs before a session scope exists).
-- Logout is recorded only when the person signs out; closing the tab leaves no logout.
CREATE TABLE auth_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('login', 'logout', 'switch')),
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'whatsapp', 'api')),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX auth_events_member_idx ON auth_events (workspace_id, membership_id, at DESC);
CREATE INDEX auth_events_at_idx ON auth_events (workspace_id, at);

CREATE OR REPLACE FUNCTION auth.record_auth_event(p_membership_id uuid, p_kind text, p_channel text, p_user_agent text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO auth_events (workspace_id, membership_id, kind, channel, user_agent)
  SELECT m.workspace_id, m.id, p_kind, coalesce(p_channel, 'web'), left(p_user_agent, 400)
  FROM memberships m WHERE m.id = p_membership_id
$$;

-- Insert-only logs ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_event_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER attendance_events_immutable
  BEFORE UPDATE OR DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_log_mutation();

CREATE TRIGGER auth_events_immutable
  BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION reject_event_log_mutation();

-- RLS ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['generated_reports', 'attendance_events', 'auth_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

-- A report is seen by the person who asked for it, the person it was submitted to, and the owner.
CREATE POLICY visible ON generated_reports FOR SELECT
  USING (app_global() OR requested_by = app_membership() OR submitted_to = app_membership());
CREATE POLICY insert ON generated_reports FOR INSERT
  WITH CHECK (app_global() OR requested_by = app_membership());
CREATE POLICY modify ON generated_reports FOR UPDATE
  USING (app_global() OR requested_by = app_membership())
  WITH CHECK (app_global() OR requested_by = app_membership());
CREATE POLICY remove ON generated_reports FOR DELETE
  USING (app_global() OR requested_by = app_membership());

-- Attendance: your own; managers, vice managers and team leads see their organisation; owner all.
CREATE POLICY visible ON attendance_events FOR SELECT
  USING (
    app_global()
    OR membership_id = app_membership()
    OR (
      coalesce(current_setting('app.role', true), '') IN ('manager', 'vice_manager', 'team_lead')
      AND membership_id IN (SELECT id FROM memberships WHERE org_id = app_org())
    )
  );
CREATE POLICY insert ON attendance_events FOR INSERT
  WITH CHECK (membership_id = app_membership());

-- Sign-in events: your own; the owner sees everyone's.
CREATE POLICY visible ON auth_events FOR SELECT
  USING (app_global() OR membership_id = app_membership());

REVOKE UPDATE, DELETE ON attendance_events FROM portfolio_app;
REVOKE INSERT, UPDATE, DELETE ON auth_events FROM portfolio_app;
