-- Rename lead/vice_lead → manager/vice_manager and add team_lead.
-- Safe to skip when schema already uses the new labels (fresh 001 installs).

-- Drop outside the DO block so a later failure cannot roll the drop back with the enum work.
DROP INDEX IF EXISTS one_lead_per_org;
DROP INDEX IF EXISTS one_manager_per_org;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'role_level' AND e.enumlabel = 'lead'
  ) THEN
    -- CHECK constraints compare role to enum literals; drop before retype.
    ALTER TABLE memberships DROP CONSTRAINT IF EXISTS owner_has_no_org;
    ALTER TABLE memberships DROP CONSTRAINT IF EXISTS owner_has_no_parent;

    ALTER TABLE memberships ALTER COLUMN role TYPE text USING role::text;
    ALTER TABLE kpis ALTER COLUMN owned_at_level TYPE text USING owned_at_level::text;
    ALTER TABLE submissions ALTER COLUMN level TYPE text USING level::text;

    DROP TYPE role_level;

    CREATE TYPE role_level AS ENUM (
      'member',
      'team_lead',
      'vice_manager',
      'manager',
      'owner'
    );

    UPDATE memberships SET role = 'manager' WHERE role = 'lead';
    UPDATE memberships SET role = 'vice_manager' WHERE role = 'vice_lead';
    UPDATE kpis SET owned_at_level = 'manager' WHERE owned_at_level = 'lead';
    UPDATE kpis SET owned_at_level = 'vice_manager' WHERE owned_at_level = 'vice_lead';
    UPDATE submissions SET level = 'manager' WHERE level = 'lead';
    UPDATE submissions SET level = 'vice_manager' WHERE level = 'vice_lead';

    ALTER TABLE memberships
      ALTER COLUMN role TYPE role_level USING role::role_level;
    ALTER TABLE kpis
      ALTER COLUMN owned_at_level TYPE role_level USING owned_at_level::role_level;
    ALTER TABLE submissions
      ALTER COLUMN level TYPE role_level USING level::role_level;

    ALTER TABLE memberships
      ADD CONSTRAINT owner_has_no_org CHECK ((role = 'owner') = (org_id IS NULL));
    ALTER TABLE memberships
      ADD CONSTRAINT owner_has_no_parent CHECK ((role <> 'owner') OR (parent_id IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS one_manager_per_org ON memberships(org_id)
  WHERE role = 'manager' AND state <> 'inactive';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'signoffs' AND column_name = 'lead_id'
  ) THEN
    ALTER TABLE signoffs RENAME COLUMN lead_id TO manager_id;
  END IF;
END $$;

UPDATE profile_sections SET edit_tier = 'manager' WHERE edit_tier = 'lead';
UPDATE memberships SET title = 'Manager' WHERE title IN ('Lead', 'Org lead', 'Organisation lead');
UPDATE memberships SET title = 'Vice manager' WHERE title IN ('Vice lead', 'Vice Lead');
UPDATE memberships SET title = 'Team lead' WHERE role = 'team_lead' AND (title IS NULL OR title IN ('Lead', 'Member'));

DROP POLICY IF EXISTS subtree_scope_activity ON activity_entries;
CREATE POLICY subtree_scope_activity ON activity_entries
  USING (
    current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager', 'team_lead')
    OR membership_id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM memberships
        WHERE id = NULLIF(current_setting('app.membership_id', true), '')::uuid
        UNION ALL
        SELECT m.id FROM memberships m JOIN sub ON m.parent_id = sub.id
      )
      SELECT id FROM sub
    )
  );

-- Demo TMS team lead (Karthik) under the manager; Harini reports to him when present.
DO $$
DECLARE
  org uuid;
  manager_id uuid;
  tl_user uuid;
  tl_membership uuid;
  harini uuid;
  pw text := encode(digest('portfolio-os:password123', 'sha256'), 'hex');
BEGIN
  SELECT id INTO org FROM organisations WHERE slug = 'tms';
  IF org IS NULL THEN
    RETURN;
  END IF;
  SELECT id INTO manager_id FROM memberships WHERE org_id = org AND role = 'manager' AND state <> 'inactive' LIMIT 1;
  IF manager_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO tl_user FROM users WHERE email = 'karthik@portfolio.local';
  IF tl_user IS NULL THEN
    INSERT INTO users (full_name, email, password_hash, is_named)
    VALUES ('Karthik', 'karthik@portfolio.local', pw, true)
    RETURNING id INTO tl_user;
  END IF;

  SELECT id INTO tl_membership FROM memberships WHERE user_id = tl_user AND org_id = org;
  IF tl_membership IS NULL THEN
    INSERT INTO memberships (user_id, org_id, role, title, parent_id, state)
    VALUES (tl_user, org, 'team_lead', 'Team lead', manager_id, 'active')
    RETURNING id INTO tl_membership;
  ELSE
    UPDATE memberships
    SET role = 'team_lead', title = 'Team lead', parent_id = manager_id, state = 'active'
    WHERE id = tl_membership;
  END IF;

  SELECT m.id INTO harini
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  WHERE m.org_id = org AND u.email = 'harini@portfolio.local'
  LIMIT 1;
  IF harini IS NOT NULL THEN
    UPDATE memberships SET parent_id = tl_membership WHERE id = harini;
  END IF;
END $$;
