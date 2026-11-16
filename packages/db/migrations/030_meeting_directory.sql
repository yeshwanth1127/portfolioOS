-- Meeting invites are workspace-wide (docs/MEETINGS.md): anyone can start a meeting with anyone
-- in the workspace (people, a team, an organisation), not only the people their role lets them
-- see elsewhere. These definer functions expose just what the invite picker needs (name, title,
-- organisation, units), never phone numbers or other person data, and only inside app_workspace().

CREATE FUNCTION auth.meeting_directory()
RETURNS TABLE (id uuid, full_name text, title text, role text, org_id uuid, unit_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, u.full_name, m.title, m.role::text, m.org_id,
         COALESCE(array_agg(DISTINCT a.unit_id) FILTER (WHERE a.unit_id IS NOT NULL), '{}')
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN assignments a ON a.user_id = m.user_id AND a.workspace_id = m.workspace_id AND a.status = 'active'
  WHERE m.workspace_id = app_workspace() AND m.state <> 'inactive'
  GROUP BY m.id, u.full_name, m.title, m.role, m.org_id
$$;

CREATE FUNCTION auth.meeting_units()
RETURNS TABLE (id uuid, parent_id uuid, type text, name text, legacy_org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, parent_id, type::text, name, legacy_org_id FROM units
  WHERE workspace_id = app_workspace() AND status = 'active'
$$;

CREATE FUNCTION auth.meeting_orgs()
RETURNS TABLE (id uuid, name text, short_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, name, short_name FROM organisations WHERE workspace_id = app_workspace()
$$;

REVOKE ALL ON FUNCTION auth.meeting_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.meeting_units() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.meeting_orgs() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_app') THEN
    GRANT EXECUTE ON FUNCTION auth.meeting_directory() TO portfolio_app;
    GRANT EXECUTE ON FUNCTION auth.meeting_units() TO portfolio_app;
    GRANT EXECUTE ON FUNCTION auth.meeting_orgs() TO portfolio_app;
  END IF;
END $$;
