SELECT to_regclass('public.org_periods') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM submissions WHERE state = 'amended');
