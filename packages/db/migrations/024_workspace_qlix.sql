-- One Qlix org per workspace, with two Qlix agents (Assistant, Report writer).
-- Two ways in (packages/api/src/modules/qlix):
--   created: Orbit creates the org through Qlix's partner API (customer new to Qlix);
--   linked:  the customer already has a Qlix org and turns the PortfolioOS plugin on there;
--            Qlix tells Orbit (webhook tenant.link_requested) and Orbit completes the link.
-- Secrets (tenant API key, runner tokens) are AES-256-GCM encrypted by the API with
-- QLIX_SECRETS_KEY; the database never holds them in clear text.

CREATE TABLE workspace_qlix (
  workspace_id uuid PRIMARY KEY DEFAULT app_workspace() REFERENCES workspaces(id),
  -- pending:      being set up        waiting_link: owner already uses Qlix; waiting for them to
  -- active:       agents usable                     turn PortfolioOS on in their Qlix org
  -- failed:       setup error         paused:       plugin turned off in Qlix (nothing deleted)
  -- disabled:     workspace closed
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'waiting_link', 'active', 'paused', 'failed', 'disabled')),
  link_mode text CHECK (link_mode IS NULL OR link_mode IN ('created', 'linked')),
  qlix_link_id text,
  qlix_org_id text,
  tenant_key_enc text,
  assistant_agent_id text,
  assistant_runner_token_enc text,
  report_agent_id text,
  report_runner_token_enc text,
  -- channel ('web' | 'whatsapp' | 'report') → Qlix conversation id, so runs group by channel.
  conversation_ids jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(conversation_ids) = 'object'),
  -- waiting_link: the owner's email Qlix will report back, and where they turn the plugin on.
  waiting_email text,
  connect_url text,
  owner_invited_at timestamptz,
  -- Qlix invitation for the workspace owner (created orgs only): pending | accepted | revoked | expired.
  owner_invite_status text CHECK (owner_invite_status IS NULL OR owner_invite_status IN ('pending', 'accepted', 'revoked', 'expired')),
  owner_invite_email text,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_qlix ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_qlix FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_isolation ON workspace_qlix AS RESTRICTIVE
  USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace());

-- Only the owner (and the system actor that runs provisioning jobs) can see or change it.
CREATE POLICY owner_all ON workspace_qlix
  USING (app_global()) WITH CHECK (app_global());

-- Linking an existing Qlix org: which workspace is waiting for this owner's email?
-- (Crosses workspaces, so it is a narrow SECURITY DEFINER lookup returning only the id.)
CREATE FUNCTION auth.qlix_waiting_workspace(p_email text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.workspace_id FROM workspace_qlix q JOIN workspaces w ON w.id = q.workspace_id
  WHERE q.status = 'waiting_link' AND w.status = 'active'
    AND lower(q.waiting_email) = lower(trim(p_email))
  ORDER BY q.updated_at DESC LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth.qlix_waiting_workspace(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_app') THEN
    GRANT EXECUTE ON FUNCTION auth.qlix_waiting_workspace(text) TO portfolio_app;
  END IF;
END $$;
