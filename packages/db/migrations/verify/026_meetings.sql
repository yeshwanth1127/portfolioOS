SELECT to_regclass('public.meetings') IS NOT NULL
  AND to_regclass('public.meeting_participants') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'meeting_by_room'
  );
