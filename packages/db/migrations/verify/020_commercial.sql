SELECT to_regclass('public.plans') IS NOT NULL
  AND to_regclass('public.workspace_entitlements') IS NOT NULL
  AND to_regclass('public.workspace_usage_daily') IS NOT NULL
  AND to_regclass('public.workspace_export_jobs') IS NOT NULL
  AND to_regclass('public.workspace_deletion_requests') IS NOT NULL
  AND EXISTS (SELECT 1 FROM plans WHERE code = 'pilot')
  AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'set_workspace_entitlement'
  );
