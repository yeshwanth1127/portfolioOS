-- Authentication bootstrap (docs/BUILD.md § 4.11).
-- Before a caller is known there is no scope for row-level security, so the few lookups that
-- identify the caller run as SECURITY DEFINER functions with a fixed search_path, returning only
-- the columns needed. Everything after identification runs in a scoped transaction.

CREATE SCHEMA IF NOT EXISTS auth;

-- Login: the account behind an email (case-insensitive).
CREATE FUNCTION auth.login_candidate(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.password_hash, u.status FROM users u WHERE lower(u.email) = lower(trim(p_email)) LIMIT 1
$$;

-- Replace a password hash after a successful login, only if it is still the hash that was verified.
CREATE FUNCTION auth.upgrade_password_hash(p_user_id uuid, p_old_hash text, p_new_hash text)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE users SET password_hash = p_new_hash WHERE id = p_user_id AND password_hash = p_old_hash RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM done)
$$;

-- The membership a user signs in with: the most senior active one.
CREATE FUNCTION auth.primary_membership(p_user_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id FROM memberships m
  WHERE m.user_id = p_user_id AND m.state <> 'inactive'
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'vice_manager' THEN 2
                       WHEN 'team_lead' THEN 3 ELSE 4 END, m.created_at
  LIMIT 1
$$;

-- The caller behind a token or run token.
CREATE FUNCTION auth.actor_for_membership(p_membership_id uuid)
RETURNS TABLE (
  id uuid, role role_level, org_id uuid, user_id uuid, title text, state member_state, parent_id uuid,
  full_name text, email text, phone_e164 text, is_named boolean,
  org_slug text, org_short_name text, org_name text,
  reports_to_name text, reports_to_role role_level, reports_to_title text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.role, m.org_id, m.user_id, m.title, m.state, m.parent_id,
         u.full_name, u.email, u.phone_e164, u.is_named,
         o.slug, o.short_name, o.name,
         pu.full_name, pm.role, pm.title
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN organisations o ON o.id = m.org_id
  LEFT JOIN memberships pm ON pm.id = m.parent_id
  LEFT JOIN users pu ON pu.id = pm.user_id
  WHERE m.id = p_membership_id AND m.state <> 'inactive' AND u.status = 'active'
$$;

-- WhatsApp: the active member behind an exact phone number (digits compared, + and spaces ignored).
-- Exact match only: a shared last-10-digits suffix across country codes never matches.
CREATE FUNCTION auth.actor_for_phone(p_phone text)
RETURNS TABLE (membership_id uuid, role role_level, full_name text, phone_e164 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.role, u.full_name, u.phone_e164
  FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE regexp_replace(coalesce(u.phone_e164, ''), '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
    AND regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    AND m.state <> 'inactive' AND u.status = 'active'
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'vice_manager' THEN 2
                       WHEN 'team_lead' THEN 3 ELSE 4 END
  LIMIT 1
$$;

-- WhatsApp: numbers allowed to talk to the agent (for the sidecar's auto-reply arming).
CREATE FUNCTION auth.registered_phones()
RETURNS TABLE (phone_e164 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.phone_e164 FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE u.phone_e164 IS NOT NULL AND u.phone_e164 <> '' AND m.state <> 'inactive' AND u.status = 'active'
$$;
