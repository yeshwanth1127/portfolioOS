SELECT to_regclass('public.projects') IS NOT NULL
  AND to_regclass('public.tasks') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assignments_project_fk'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'projects' AND policyname = 'visible'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tasks' AND policyname = 'visible'
  );
