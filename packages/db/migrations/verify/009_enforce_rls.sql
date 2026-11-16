SELECT to_regprocedure('public.app_global()') IS NOT NULL
   AND (SELECT bool_and(relforcerowsecurity) FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname IN ('submissions', 'kpis', 'memberships', 'wa_outbox'));
