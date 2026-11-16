-- Secondary assignments: actors see assigned units and their ancestor chain in the unit tree.
-- Uses SECURITY DEFINER helpers to avoid units ↔ assignments RLS recursion.

CREATE OR REPLACE FUNCTION auth.unit_on_assignment_chain(p_unit_id uuid, p_assignment_unit_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id FROM units WHERE id = p_assignment_unit_id
    UNION ALL
    SELECT u.id, u.parent_id FROM units u INNER JOIN up ON u.id = up.parent_id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = p_unit_id);
$$;

CREATE OR REPLACE FUNCTION auth.actor_secondary_assignment_unit_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.unit_id
  FROM assignments a
  JOIN memberships m ON m.user_id = a.user_id AND m.id = app_membership()
  WHERE a.workspace_id = app_workspace()
    AND a.status = 'active'
    AND a.unit_id IS NOT NULL
    AND NOT a.is_primary;
$$;

CREATE OR REPLACE FUNCTION auth.assignment_unit_in_actor_org(p_unit_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM units u
    WHERE u.id = p_unit_id AND u.legacy_org_id = app_org()
  );
$$;

DROP POLICY IF EXISTS visible ON units;
CREATE POLICY visible ON units USING (
  app_global()
  OR legacy_org_id = app_org()
  OR (
    app_org() IS NOT NULL
    AND (
      auth.unit_in_org_tree(id, app_org(), app_workspace())
      OR (
        parent_id IS NOT NULL
        AND auth.unit_in_org_tree(parent_id, app_org(), app_workspace())
      )
    )
  )
  OR EXISTS (
    SELECT 1
    FROM auth.actor_secondary_assignment_unit_ids() AS aid(unit_id)
    WHERE auth.unit_on_assignment_chain(units.id, aid.unit_id)
  )
);

DROP POLICY IF EXISTS visible ON assignments;
CREATE POLICY visible ON assignments USING (
  app_global()
  OR id = app_membership()
  OR user_id = (SELECT user_id FROM memberships WHERE id = app_membership())
  OR auth.assignment_unit_in_actor_org(unit_id)
);
