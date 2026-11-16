-- The owner's Qlix login, shown and changeable in Orbit (Settings → Qlix agents).
-- Only for Qlix orgs Orbit created (link_mode 'created'); a linked org's accounts belong to the
-- customer and Orbit never sets their passwords. The password is AES-256-GCM encrypted by the API
-- (QLIX_SECRETS_KEY) and returned only to the workspace owner on request.
ALTER TABLE workspace_qlix
  ADD COLUMN qlix_org_name text,
  ADD COLUMN owner_login_email text,
  ADD COLUMN owner_password_enc text,
  ADD COLUMN owner_password_set_at timestamptz;
