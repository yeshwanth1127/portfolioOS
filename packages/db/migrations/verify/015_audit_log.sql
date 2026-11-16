SELECT to_regclass('public.audit_log') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'ws_isolation'
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_immutable'
  );
