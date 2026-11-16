-- Meetings: video meetings hosted on our own LiveKit server (docs/MEETINGS.md).
-- A meeting is one LiveKit room. Scheduled meetings also have a calendar event (kind 'meeting')
-- so invitees see them on the calendar and get reminders; instant meetings may have none.

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL DEFAULT app_workspace() REFERENCES workspaces(id),
  org_id uuid,
  calendar_event_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  host_membership_id uuid NOT NULL,
  -- LiveKit room name; globally unique because one LiveKit server serves every workspace.
  room_name text NOT NULL UNIQUE CHECK (room_name ~ '^orbit-[0-9a-f-]{36}$'),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  started_at timestamptz,
  ended_at timestamptz,
  -- The workspace's Qlix Meeting Assistant attends (phase 2; stored now so the choice is kept).
  qlix_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (ends_at >= starts_at),
  FOREIGN KEY (workspace_id, org_id) REFERENCES organisations (workspace_id, id),
  FOREIGN KEY (workspace_id, host_membership_id) REFERENCES memberships (workspace_id, id),
  FOREIGN KEY (workspace_id, calendar_event_id) REFERENCES calendar_events (workspace_id, id)
    ON DELETE SET NULL (calendar_event_id)
);
CREATE INDEX meetings_starts_idx ON meetings (workspace_id, starts_at DESC);
CREATE INDEX meetings_event_idx ON meetings (calendar_event_id) WHERE calendar_event_id IS NOT NULL;

-- Invitees and everyone who actually joined (joined_at set by LiveKit webhooks).
CREATE TABLE meeting_participants (
  workspace_id uuid NOT NULL DEFAULT app_workspace(),
  meeting_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'attendee' CHECK (role IN ('host', 'attendee')),
  invited boolean NOT NULL DEFAULT true,
  joined_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY (meeting_id, membership_id),
  FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships (workspace_id, id)
);
CREATE INDEX meeting_participants_member_idx ON meeting_participants (workspace_id, membership_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['meetings', 'meeting_participants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I AS RESTRICTIVE USING (workspace_id = app_workspace()) WITH CHECK (workspace_id = app_workspace())',
      t
    );
  END LOOP;
END $$;

-- Meetings I am a participant of (definer: reads participants without re-entering their policy).
CREATE FUNCTION app_my_meetings() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT meeting_id FROM meeting_participants
  WHERE workspace_id = app_workspace() AND membership_id = app_membership()
$$;

-- Same visibility as calendar events: the owner sees all; others see their organisation's
-- meetings, meetings they host, and meetings they are invited to.
CREATE POLICY visible ON meetings
  USING (app_global() OR org_id = app_org() OR host_membership_id = app_membership() OR id IN (SELECT app_my_meetings()))
  WITH CHECK (app_global() OR host_membership_id = app_membership() OR org_id = app_org());
CREATE POLICY visible ON meeting_participants
  USING (app_global() OR membership_id = app_membership() OR meeting_id IN (SELECT id FROM meetings))
  WITH CHECK (app_global() OR meeting_id IN (SELECT id FROM meetings));

-- LiveKit webhooks name only the room: which workspace owns it? (Crosses workspaces, so a
-- narrow definer lookup that returns just the ids.)
CREATE FUNCTION auth.meeting_by_room(p_room text)
RETURNS TABLE (meeting_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.workspace_id FROM meetings m WHERE m.room_name = p_room
$$;

-- The first person to join starts a scheduled meeting. Invitees can't update the meeting row
-- (only its host / org / owner can), so this is the one change they may make. The caller has
-- already loaded the meeting under RLS, so it is visible to them.
CREATE FUNCTION auth.start_meeting(p_meeting_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE meetings SET status = 'live', started_at = coalesce(started_at, now()), updated_at = now()
  WHERE id = p_meeting_id AND workspace_id = app_workspace() AND status = 'scheduled'
$$;

REVOKE ALL ON FUNCTION auth.meeting_by_room(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.start_meeting(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_app') THEN
    GRANT EXECUTE ON FUNCTION auth.meeting_by_room(text) TO portfolio_app;
    GRANT EXECUTE ON FUNCTION auth.start_meeting(uuid) TO portfolio_app;
  END IF;
END $$;
