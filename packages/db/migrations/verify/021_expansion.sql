SELECT to_regclass('public.task_dependencies') IS NOT NULL
  AND to_regclass('public.project_templates') IS NOT NULL
  AND to_regclass('public.attachments') IS NOT NULL
  AND to_regclass('public.saved_views') IS NOT NULL
  AND to_regclass('public.calendar_integrations') IS NOT NULL
  AND to_regclass('public.billing_customers') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'estimate_hours'
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'task_dependencies_no_cycle'
  )
  AND EXISTS (
    SELECT 1 FROM plans WHERE code = 'pilot' AND features @> '["billing"]'::jsonb
  );
