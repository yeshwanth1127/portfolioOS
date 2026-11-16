SELECT to_regclass('public.generated_reports') IS NOT NULL
  AND to_regclass('public.attendance_events') IS NOT NULL
  AND to_regclass('public.auth_events') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'record_auth_event'
  );
