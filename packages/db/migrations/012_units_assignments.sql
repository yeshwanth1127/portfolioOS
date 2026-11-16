-- Phase 3 — People & units (docs/phase3-people-units.md, BUILD § 7).
-- DDL + backfill from organisations / memberships; memberships remains writable.

CREATE TYPE unit_type AS ENUM ('organisation', 'branch', 'department', 'team');

CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  parent_id uuid,
  type unit_type NOT NULL,
  name text NOT NULL,
  short_name text,
  code text,
  status text NOT NULL DEFAULT 'active',
  legacy_org_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES units (workspace_id, id)
);

CREATE UNIQUE INDEX units_sibling_name ON units (
  workspace_id,
  COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  unit_id uuid,
  project_id uuid,
  role text NOT NULL,
  title text NOT NULL DEFAULT '',
  reports_to uuid,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  starts_on date,
  ends_on date,
  legacy_membership_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (num_nonnulls(unit_id, project_id) = 1),
  CHECK (role IN ('unit_manager', 'unit_deputy', 'team_lead', 'contributor')),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id),
  FOREIGN KEY (workspace_id, reports_to) REFERENCES assignments (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members (workspace_id, user_id)
);

CREATE UNIQUE INDEX one_primary_assignment ON assignments (workspace_id, user_id)
  WHERE is_primary AND status = 'active';

CREATE UNIQUE INDEX one_unit_manager_per_org ON assignments (workspace_id, unit_id)
  WHERE role = 'unit_manager' AND status = 'active';

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  email text,
  phone_e164 text,
  role text NOT NULL,
  unit_id uuid NOT NULL,
  token_hash text,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL),
  CHECK (role IN ('unit_manager', 'unit_deputy', 'team_lead', 'contributor')),
  FOREIGN KEY (workspace_id, unit_id) REFERENCES units (workspace_id, id)
);

CREATE OR REPLACE FUNCTION check_unit_parent_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_type unit_type;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.type <> 'organisation' THEN
      RAISE EXCEPTION 'only organisation units may be workspace roots';
    END IF;
    RETURN NEW;
  END IF;
  SELECT type INTO parent_type
  FROM units
  WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id;
  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'parent unit not found';
  END IF;
  IF NEW.type = 'organisation' THEN
    RAISE EXCEPTION 'organisation unit cannot have a parent';
  ELSIF NEW.type = 'branch' AND parent_type <> 'organisation' THEN
    RAISE EXCEPTION 'branch must be under an organisation';
  ELSIF NEW.type = 'department' AND parent_type NOT IN ('organisation', 'branch') THEN
    RAISE EXCEPTION 'department must be under an organisation or branch';
  ELSIF NEW.type = 'team' AND parent_type NOT IN ('organisation', 'branch', 'department') THEN
    RAISE EXCEPTION 'team must be under an organisation, branch, or department';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER units_parent_type_trg
  BEFORE INSERT OR UPDATE OF parent_id, type ON units
  FOR EACH ROW EXECUTE FUNCTION check_unit_parent_type();

-- Row-level security -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'assignments', 'invitations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

-- Workspace owner sees the full unit tree; others see units tied to their organisation (legacy org id).
CREATE POLICY visible ON units USING (app_global() OR legacy_org_id = app_org());

CREATE POLICY visible ON assignments USING (
  app_global()
  OR id = app_membership()
  OR unit_id IN (SELECT id FROM units WHERE legacy_org_id = app_org())
);

CREATE POLICY visible ON invitations USING (
  app_global()
  OR unit_id IN (
    SELECT id FROM units
    WHERE workspace_id = app_workspace() AND legacy_org_id = app_org()
  )
);

-- Idempotent backfill (migration-time data + post-migration seeds / new orgs).
CREATE OR REPLACE FUNCTION auth.sync_units_from_legacy()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO units (workspace_id, parent_id, type, name, short_name, status, legacy_org_id)
  SELECT o.workspace_id, NULL, 'organisation', o.name, o.short_name, o.status, o.id
  FROM organisations o
  WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.legacy_org_id = o.id)
  ORDER BY o.created_at;

  WITH sole_org AS (
    SELECT m.workspace_id, m.user_id
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.role <> 'owner'
      AND m.state <> 'inactive'
      AND u.is_named = true
      AND u.status = 'active'
    GROUP BY m.workspace_id, m.user_id
    HAVING count(*) = 1
  )
  INSERT INTO assignments (
    id, workspace_id, user_id, unit_id, role, title, status, is_primary, legacy_membership_id
  )
  SELECT
    m.id,
    m.workspace_id,
    m.user_id,
    un.id,
    CASE m.role
      WHEN 'manager' THEN 'unit_manager'
      WHEN 'vice_manager' THEN 'unit_deputy'
      WHEN 'team_lead' THEN 'team_lead'
      ELSE 'contributor'
    END,
    m.title,
    CASE WHEN m.state = 'active' THEN 'active' ELSE 'inactive' END,
    EXISTS (SELECT 1 FROM sole_org s WHERE s.workspace_id = m.workspace_id AND s.user_id = m.user_id),
    m.id
  FROM memberships m
  JOIN users usr ON usr.id = m.user_id
  JOIN units un ON un.legacy_org_id = m.org_id AND un.workspace_id = m.workspace_id
  WHERE m.role <> 'owner'
    AND m.state <> 'inactive'
    AND usr.is_named = true
    AND usr.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.legacy_membership_id = m.id);

  -- reports_to → parent assignment id (= memberships.id). Skip parents that were not
  -- backfilled (owners, unnamed, inactive) so the composite FK can succeed.
  UPDATE assignments a
  SET reports_to = m.parent_id
  FROM memberships m
  WHERE a.legacy_membership_id = m.id
    AND m.parent_id IS NOT NULL
    AND a.workspace_id = m.workspace_id
    AND EXISTS (
      SELECT 1 FROM assignments p
      WHERE p.workspace_id = a.workspace_id AND p.id = m.parent_id
    )
    AND (a.reports_to IS DISTINCT FROM m.parent_id);

  INSERT INTO invitations (workspace_id, email, phone_e164, role, unit_id)
  SELECT
    m.workspace_id,
    u.email,
    u.phone_e164,
    CASE m.role
      WHEN 'manager' THEN 'unit_manager'
      WHEN 'vice_manager' THEN 'unit_deputy'
      WHEN 'team_lead' THEN 'team_lead'
      ELSE 'contributor'
    END,
    un.id
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  JOIN units un ON un.legacy_org_id = m.org_id AND un.workspace_id = m.workspace_id
  WHERE m.role <> 'owner'
    AND m.state <> 'inactive'
    AND (u.is_named = false OR m.state = 'pending_name')
    AND NOT EXISTS (
      SELECT 1 FROM invitations i
      WHERE i.workspace_id = m.workspace_id
        AND i.unit_id = un.id
        AND coalesce(i.email, '') = coalesce(u.email, '')
    );

  UPDATE memberships m
  SET state = 'inactive'
  FROM users u
  WHERE u.id = m.user_id
    AND m.role <> 'owner'
    AND m.state <> 'inactive'
    AND (u.is_named = false OR m.state = 'pending_name');

  UPDATE workspace_members wm
  SET workspace_role = 'owner'
  FROM memberships m
  WHERE m.user_id = wm.user_id
    AND m.workspace_id = wm.workspace_id
    AND m.role = 'owner'
    AND m.state <> 'inactive'
    AND wm.workspace_role <> 'owner';
END;
$$;

SELECT auth.sync_units_from_legacy();
