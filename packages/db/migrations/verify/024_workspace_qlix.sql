SELECT to_regclass('public.workspace_qlix') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'workspace_qlix' AND policyname = 'owner_all'
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'qlix_waiting_workspace'
  );
