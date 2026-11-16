SELECT to_regclass('public.milestones') IS NOT NULL
  AND to_regclass('public.project_units') IS NOT NULL
  AND to_regclass('public.notifications') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'mine'
  );
