-- Managers see child units (branch / department / team) under their organisation root.

CREATE OR REPLACE FUNCTION auth.unit_in_org_tree(p_unit_id uuid, p_org_id uuid, p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id, legacy_org_id, workspace_id
    FROM units
    WHERE id = p_unit_id
    UNION ALL
    SELECT u.id, u.parent_id, u.legacy_org_id, u.workspace_id
    FROM units u
    INNER JOIN up ON u.id = up.parent_id
    WHERE up.parent_id IS NOT NULL
  )
  SELECT EXISTS (
    SELECT 1 FROM up
    WHERE workspace_id = p_workspace_id AND legacy_org_id = p_org_id
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
);
