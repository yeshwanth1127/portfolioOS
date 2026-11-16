-- Phase 4 — permission audit trail (BUILD §3 Audit; broader kinds in Phase 6+).

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  actor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('permission.allow', 'permission.deny')),
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships (workspace_id, id)
);

CREATE INDEX audit_log_workspace_at_idx ON audit_log (workspace_id, at DESC);
CREATE INDEX audit_log_kind_idx ON audit_log (workspace_id, kind) WHERE kind LIKE 'permission.%';

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY ws_isolation ON audit_log AS RESTRICTIVE
  USING (workspace_id = app_workspace())
  WITH CHECK (workspace_id = app_workspace());

CREATE POLICY visible ON audit_log FOR SELECT
  USING (app_global() OR workspace_id = app_workspace());

CREATE POLICY insert_scope ON audit_log FOR INSERT
  WITH CHECK (workspace_id = app_workspace());

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is insert-only';
END;
$$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

REVOKE UPDATE, DELETE ON audit_log FROM portfolio_app;
