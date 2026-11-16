SELECT to_regclass('public.meeting_transcript_segments') IS NOT NULL
  AND to_regclass('public.meeting_summaries') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspace_qlix' AND column_name = 'meeting_agent_id'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meetings' AND column_name = 'summary_status'
  );
