-- Meeting action items → tasks (docs/MEETINGS.md, phase 3).
-- Summaries are written only by the system actor (027). A person who manages the meeting may
-- accept or reject one proposed action item; the API checks that (host / owner / org manager)
-- and creates the task as that person, then records the decision here.
CREATE FUNCTION auth.set_meeting_action_item(p_meeting_id uuid, p_index int, p_status text, p_task_id uuid)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE meeting_summaries s
     SET action_items = jsonb_set(
           s.action_items, ARRAY[p_index::text],
           (s.action_items -> p_index) || jsonb_build_object('status', p_status, 'task_id', p_task_id,
                                                            'decided_by', app_membership(), 'decided_at', now())),
         updated_at = now()
   WHERE s.meeting_id = p_meeting_id
     AND s.workspace_id = app_workspace()
     AND p_status IN ('accepted', 'rejected', 'proposed')
     AND p_index >= 0 AND p_index < jsonb_array_length(s.action_items)
  RETURNING s.action_items -> p_index
$$;

REVOKE ALL ON FUNCTION auth.set_meeting_action_item(uuid, int, text, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portfolio_app') THEN
    GRANT EXECUTE ON FUNCTION auth.set_meeting_action_item(uuid, int, text, uuid) TO portfolio_app;
  END IF;
END $$;
