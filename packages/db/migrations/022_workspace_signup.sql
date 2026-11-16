-- Self-serve workspaces (Orbit SaaS): anyone can sign up and get their own workspace, and a
-- signed-in person can open further workspaces. Both run before a scope exists, so they are
-- definer functions in schema auth (docs/BUILD.md § 4.11), like the other bootstrap lookups.
--
-- The existing seven Sona organisations already live in one workspace (migration 010); it is
-- shown to people as "Sona Group".

UPDATE workspaces SET name = 'Sona Group' WHERE slug = 'sona' AND name = 'Sona';

-- A free workspace slug derived from a name: "Acme Holdings" → acme-holdings, acme-holdings-2, …
CREATE FUNCTION auth.free_workspace_slug(p_name text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  base text := trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  candidate text;
  n int := 1;
BEGIN
  IF length(base) < 2 THEN base := 'workspace'; END IF;
  base := left(base, 34);
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM workspaces WHERE slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END;
$$;

-- A new workspace owned by an existing user. Returns the owner membership id to sign in with.
CREATE FUNCTION auth.create_workspace(
  p_user_id uuid,
  p_name text,
  p_timezone text DEFAULT 'Asia/Kolkata',
  p_currency text DEFAULT 'INR'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws uuid;
  mid uuid;
  clean_name text := left(btrim(coalesce(p_name, '')), 80);
BEGIN
  IF length(clean_name) < 2 THEN RAISE EXCEPTION 'workspace_name_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'user_inactive';
  END IF;
  IF (SELECT count(*) FROM workspace_members WHERE user_id = p_user_id AND workspace_role = 'owner') >= 10 THEN
    RAISE EXCEPTION 'workspace_limit';
  END IF;

  INSERT INTO workspaces (name, slug, timezone, currency)
  VALUES (
    clean_name,
    auth.free_workspace_slug(clean_name),
    coalesce(nullif(btrim(p_timezone), ''), 'Asia/Kolkata'),
    upper(coalesce(nullif(btrim(p_currency), ''), 'INR'))
  )
  RETURNING id INTO ws;

  -- workspace_id columns default to app_workspace(); scope the rest of this transaction to it.
  PERFORM set_config('app.workspace_id', ws::text, true);

  INSERT INTO workspace_members (workspace_id, user_id, workspace_role)
  VALUES (ws, p_user_id, 'owner');
  INSERT INTO memberships (workspace_id, user_id, role, title, state)
  VALUES (ws, p_user_id, 'owner', 'Owner', 'active')
  RETURNING id INTO mid;
  RETURN mid;
END;
$$;

-- Sign-up: a new person and their first workspace in one step. Email must be unused.
CREATE FUNCTION auth.signup(
  p_full_name text,
  p_email text,
  p_password_hash text,
  p_workspace_name text,
  p_timezone text DEFAULT 'Asia/Kolkata'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  uid uuid;
  clean_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'email_invalid'; END IF;
  IF length(btrim(coalesce(p_full_name, ''))) < 2 THEN RAISE EXCEPTION 'name_required'; END IF;
  IF coalesce(p_password_hash, '') = '' THEN RAISE EXCEPTION 'password_required'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = clean_email) THEN RAISE EXCEPTION 'email_taken'; END IF;

  INSERT INTO users (full_name, email, password_hash, is_named)
  VALUES (left(btrim(p_full_name), 120), clean_email, p_password_hash, true)
  RETURNING id INTO uid;

  RETURN auth.create_workspace(uid, p_workspace_name, p_timezone);
END;
$$;

REVOKE ALL ON FUNCTION auth.free_workspace_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.create_workspace(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.signup(text, text, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_app') THEN
    GRANT EXECUTE ON FUNCTION auth.free_workspace_slug(text) TO portfolio_app;
    GRANT EXECUTE ON FUNCTION auth.create_workspace(uuid, text, text, text) TO portfolio_app;
    GRANT EXECUTE ON FUNCTION auth.signup(text, text, text, text, text) TO portfolio_app;
  END IF;
END $$;
