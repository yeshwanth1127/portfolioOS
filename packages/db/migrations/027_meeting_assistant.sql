-- Meeting Assistant (docs/MEETINGS.md): a third Qlix agent per workspace, meeting transcripts
-- written by the meeting bot, and the summary Qlix writes after the call.

-- The workspace's Qlix "Meeting Assistant" agent (created like Assistant and Report writer).
ALTER TABLE workspace_qlix
  ADD COLUMN meeting_agent_id text,
  ADD COLUMN meeting_runner_token_enc text;

ALTER TABLE meetings
  -- One Qlix conversation per meeting: live questions and the summary share its context.
  ADD COLUMN qlix_conversation_id text,
  -- none: no summary wanted (assistant off) · pending/running · ready · empty: nothing was said
  -- failed: see summary_error (e.g. Qlix not connected); the host can retry.
  ADD COLUMN summary_status text NOT NULL DEFAULT 'none'
    CHECK (summary_status IN ('none', 'pending', 'running', 'ready', 'empty', 'failed')),
  ADD COLUMN summary_error text CHECK (summary_error IS NULL OR length(summary_error) <= 500);

-- What was said, one row per utterance. Written only by the meeting bot (through the API's
-- service route, as the system actor); read by anyone who can see the meeting.
CREATE TABLE meeting_transcript_segments (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace(),
  meeting_id uuid NOT NULL,
  membership_id uuid,
  speaker_name text NOT NULL CHECK (length(speaker_name) BETWEEN 1 AND 200),
  -- Milliseconds since the bot joined the call.
  started_ms int NOT NULL CHECK (started_ms >= 0),
  ended_ms int NOT NULL CHECK (ended_ms >= started_ms),
  text text NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id)
);
CREATE INDEX meeting_transcript_meeting_idx ON meeting_transcript_segments (meeting_id, started_ms);

-- The Meeting Assistant's write-up. action_items: [{ text, owner_name, owner_membership_id, due_date,
-- status: proposed|accepted|rejected, task_id }] — accepting one creates a task (phase 3).
CREATE TABLE meeting_summaries (
  meeting_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL DEFAULT app_workspace(),
  summary text NOT NULL CHECK (length(summary) <= 8000),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(decisions) = 'array'),
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_items) = 'array'),
  qlix_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_transcript_segments', 'meeting_summaries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
    -- Readable with the meeting; written (insert, update, delete) by the system actor only:
    -- the bot's service route and the summary job.
    EXECUTE format(
      'CREATE POLICY visible ON %I FOR SELECT USING (app_global() OR meeting_id IN (SELECT id FROM meetings))',
      t
    );
    EXECUTE format(
      'CREATE POLICY system_write ON %I FOR ALL USING (current_setting(''app.role'', true) = ''system'') WITH CHECK (current_setting(''app.role'', true) = ''system'')',
      t
    );
  END LOOP;
END $$;
