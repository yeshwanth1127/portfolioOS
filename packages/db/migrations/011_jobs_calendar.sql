-- Durable job queue + calendar events (docs/BUILD.md § 6.5, § 6.6).

-- Jobs: reminders, notifications, digests. A worker claims due jobs with FOR UPDATE SKIP LOCKED;
-- failures back off; dedupe_key makes enqueueing idempotent.
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_by text,
  locked_at timestamptz,
  done_at timestamptz,
  failed_at timestamptz,
  last_error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  org_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'meeting'
    CHECK (kind IN ('meeting', 'review', 'visit', 'call', 'deadline', 'other')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  location text,
  description text,
  reminder_minutes int[] NOT NULL DEFAULT '{30}',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, org_id) REFERENCES organisations (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES memberships (workspace_id, id),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX calendar_events_range_idx ON calendar_events (workspace_id, starts_at);

CREATE TABLE calendar_event_participants (
  workspace_id uuid NOT NULL DEFAULT app_workspace(),
  event_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  response text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'yes', 'no', 'maybe')),
  PRIMARY KEY (event_id, membership_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES calendar_events (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id)
);

-- Visibility: workspace isolation (restrictive) +
--   events: the owner sees all; others see their organisation's events, events they created,
--   and events they are invited to.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['jobs', 'calendar_events', 'calendar_event_participants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

-- Jobs are written only through auth.enqueue_job / auth.cancel_queued_jobs (definer, scoped via app_workspace).
-- The worker reads through auth.claim_jobs (definer).
CREATE POLICY worker_read ON jobs FOR SELECT USING (current_setting('app.role', true) = 'system');

-- Events I am invited to (definer: reads participants without re-entering their policy).
CREATE FUNCTION app_invited_events() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT event_id FROM calendar_event_participants
  WHERE workspace_id = app_workspace() AND membership_id = app_membership()
$$;

-- Display names for calendar rows the caller can already see (avoids INNER JOIN on memberships RLS).
CREATE FUNCTION auth.workspace_member_name(p_membership_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.full_name FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.id = p_membership_id AND m.workspace_id = app_workspace()
$$;

CREATE POLICY visible ON calendar_events
  USING (app_global() OR org_id = app_org() OR created_by = app_membership() OR id IN (SELECT app_invited_events()))
  WITH CHECK (app_global() OR created_by = app_membership() OR org_id = app_org());
CREATE POLICY visible ON calendar_event_participants
  USING (app_global() OR membership_id = app_membership() OR event_id IN (SELECT id FROM calendar_events))
  WITH CHECK (app_global() OR membership_id = app_membership() OR event_id IN (SELECT id FROM calendar_events));

-- Worker: due jobs for every workspace, claimed atomically (definer: the worker has no scope yet).
CREATE FUNCTION auth.enqueue_job(p_kind text, p_payload jsonb, p_run_at timestamptz, p_dedupe_key text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO jobs (workspace_id, kind, payload, run_at, dedupe_key)
  SELECT app_workspace(), p_kind, coalesce(p_payload, '{}'::jsonb), p_run_at, p_dedupe_key
  ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET
    run_at = EXCLUDED.run_at, payload = EXCLUDED.payload,
    done_at = NULL, failed_at = NULL, attempts = 0, last_error = NULL
$$;

CREATE FUNCTION auth.cancel_queued_jobs(p_prefix text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs SET done_at = now(), last_error = 'cancelled'
  WHERE workspace_id = app_workspace()
    AND dedupe_key LIKE p_prefix || '%' AND done_at IS NULL AND failed_at IS NULL
$$;

CREATE FUNCTION auth.claim_jobs(p_worker text, p_limit int)
RETURNS TABLE (id bigint, workspace_id uuid, kind text, payload jsonb, attempts int)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT j.id FROM jobs j
    WHERE j.done_at IS NULL AND j.failed_at IS NULL AND j.run_at <= now()
      AND (j.locked_at IS NULL OR j.locked_at < now() - interval '5 minutes')
    ORDER BY j.run_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs j SET locked_by = p_worker, locked_at = now(), attempts = j.attempts + 1
  FROM due WHERE j.id = due.id
  RETURNING j.id, j.workspace_id, j.kind, j.payload, j.attempts
$$;

CREATE FUNCTION auth.finish_job(p_id bigint, p_error text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs SET
    locked_by = NULL, locked_at = NULL,
    done_at = CASE WHEN p_error IS NULL THEN now() END,
    last_error = p_error,
    failed_at = CASE WHEN p_error IS NOT NULL AND attempts >= max_attempts THEN now() END,
    run_at = CASE WHEN p_error IS NOT NULL THEN now() + (interval '30 seconds' * power(2, attempts)) ELSE run_at END
  WHERE id = p_id
$$;
