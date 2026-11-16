SELECT to_regclass('public.kpi_goals') IS NOT NULL
   AND to_regclass('public.scores_kpi_period_cadence') IS NOT NULL
   AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'scores' AND column_name = 'paced_goal');
