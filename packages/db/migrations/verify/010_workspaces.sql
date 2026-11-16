SELECT to_regclass('public.workspaces') IS NOT NULL
   AND to_regclass('public.workspace_members') IS NOT NULL
   AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'submissions' AND column_name = 'workspace_id')
   AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'submissions' AND policyname = 'ws_isolation' AND permissive = 'RESTRICTIVE');
