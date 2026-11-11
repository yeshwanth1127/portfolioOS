-- PortfolioOS core schema (from build specification)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE role_level AS ENUM ('member', 'team_lead', 'vice_manager', 'manager', 'owner');
CREATE TYPE member_state AS ENUM ('active', 'pending_name', 'inactive');
CREATE TYPE how_often AS ENUM (
  'Every day',
  'Every week',
  'Every month',
  'Every quarter'
);
CREATE TYPE direction AS ENUM ('higher_is_better', 'lower_is_better');
CREATE TYPE rollup AS ENUM ('sum', 'average', 'latest', 'manual');
CREATE TYPE kpi_source AS ENUM ('report', 'derived', 'tbd');
CREATE TYPE rag AS ENUM ('green', 'amber', 'red', 'unscored');
CREATE TYPE sub_state AS ENUM (
  'draft', 'submitted', 'validated', 'rejected', 'locked', 'amended'
);

CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  short_name text NOT NULL,
  sector text NOT NULL,
  descriptor text NOT NULL,
  positioning text,
  is_department boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  phone_e164 text UNIQUE,
  email text UNIQUE,
  password_hash text,
  is_named boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid REFERENCES organisations(id),
  role role_level NOT NULL,
  title text NOT NULL,
  parent_id uuid REFERENCES memberships(id),
  state member_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_has_no_org CHECK ((role = 'owner') = (org_id IS NULL)),
  CONSTRAINT owner_has_no_parent CHECK (role <> 'owner' OR parent_id IS NULL)
);

CREATE UNIQUE INDEX one_manager_per_org ON memberships(org_id)
  WHERE role = 'manager' AND state <> 'inactive';
CREATE INDEX memberships_parent ON memberships(parent_id);

CREATE TABLE revenue_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  tier text NOT NULL,
  pricing_model text,
  status text NOT NULL DEFAULT 'proposed',
  approved_by uuid REFERENCES memberships(id)
);

CREATE TABLE kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  code text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  owned_at_level role_level NOT NULL,
  owner_id uuid REFERENCES memberships(id),
  for_org_id uuid REFERENCES organisations(id),
  how_often how_often NOT NULL,
  direction direction NOT NULL DEFAULT 'higher_is_better',
  rollup_method rollup NOT NULL DEFAULT 'manual',
  target numeric,
  green_at numeric,
  amber_at numeric,
  evidence_required boolean NOT NULL DEFAULT false,
  source_tag kpi_source NOT NULL,
  rationale text NOT NULL,
  revenue_line_id uuid REFERENCES revenue_lines(id),
  unmeasured boolean NOT NULL DEFAULT false,
  unmeasured_reason text,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES memberships(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  CONSTRAINT thresholds_need_target CHECK (
    target IS NULL OR (green_at IS NOT NULL AND amber_at IS NOT NULL)
  )
);

CREATE TABLE kpi_audit (
  id bigserial PRIMARY KEY,
  kpi_id uuid NOT NULL REFERENCES kpis(id),
  field text NOT NULL,
  old_value text,
  new_value text,
  reason text,
  changed_by uuid NOT NULL REFERENCES memberships(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  kpi_id uuid NOT NULL REFERENCES kpis(id),
  membership_id uuid NOT NULL REFERENCES memberships(id),
  period_date date NOT NULL,
  value numeric NOT NULL,
  note text,
  evidence_url text,
  channel text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_lookup ON activity_entries(kpi_id, period_date);

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  kpi_id uuid NOT NULL REFERENCES kpis(id),
  period_date date NOT NULL,
  level role_level NOT NULL,
  value numeric,
  state sub_state NOT NULL DEFAULT 'draft',
  submitted_by uuid REFERENCES memberships(id),
  submitted_at timestamptz,
  validated_by uuid REFERENCES memberships(id),
  validated_at timestamptz,
  reject_reason text,
  channel text NOT NULL DEFAULT 'web',
  UNIQUE (kpi_id, period_date, level)
);

CREATE TABLE signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  period_date date NOT NULL,
  manager_id uuid NOT NULL REFERENCES memberships(id),
  locked_at timestamptz NOT NULL DEFAULT now(),
  note text,
  UNIQUE (org_id, period_date)
);

CREATE TABLE scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  kpi_id uuid NOT NULL REFERENCES kpis(id),
  period_date date NOT NULL,
  value numeric,
  rag rag NOT NULL DEFAULT 'unscored',
  variance_pct numeric,
  scored_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kpi_id, period_date)
);

CREATE TABLE amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  old_value numeric NOT NULL,
  new_value numeric NOT NULL,
  reason text NOT NULL,
  made_by uuid NOT NULL REFERENCES memberships(id),
  made_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profile_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  kind text NOT NULL,
  body jsonb NOT NULL,
  edit_tier text NOT NULL DEFAULT 'manager',
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES memberships(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);

CREATE TABLE case_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  client text NOT NULL,
  title text NOT NULL,
  problem text,
  solution text,
  outcomes jsonb NOT NULL DEFAULT '[]'
);

CREATE TABLE partnerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  renews_on date
);

CREATE TABLE org_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_org uuid NOT NULL REFERENCES organisations(id),
  to_org uuid NOT NULL REFERENCES organisations(id),
  kind text NOT NULL,
  note text,
  CHECK (from_org <> to_org)
);

CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organisations(id),
  kind text NOT NULL,
  kpi_id uuid REFERENCES kpis(id),
  body text NOT NULL,
  raised_by uuid REFERENCES memberships(id),
  assigned_to uuid REFERENCES memberships(id),
  state text NOT NULL DEFAULT 'open',
  decision text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id),
  agent text NOT NULL,
  channel text NOT NULL DEFAULT 'whatsapp',
  context jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_tool_calls (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES agent_sessions(id),
  tool text NOT NULL,
  args jsonb NOT NULL,
  allowed boolean NOT NULL,
  result_rows integer,
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_pending_confirms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships(id),
  action text NOT NULL,
  payload jsonb NOT NULL,
  preview text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_auth_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wa_outbox (
  id bigserial PRIMARY KEY,
  to_phone text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  send_after timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX outbox_due ON wa_outbox(state, send_after);
