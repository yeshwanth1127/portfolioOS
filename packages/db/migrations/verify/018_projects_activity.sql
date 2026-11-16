SELECT to_regclass('public.comments') IS NOT NULL
  AND to_regclass('public.project_updates') IS NOT NULL
  AND to_regclass('public.activity_log') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'health_override'
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'tasks_milestone_project'
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'activity_log_immutable'
  );
