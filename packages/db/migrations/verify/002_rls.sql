-- RLS switched on for the four original tables (their policies are replaced later by 009)
SELECT (SELECT bool_and(relrowsecurity) FROM pg_class
        WHERE relname IN ('submissions', 'activity_entries', 'kpis', 'scores') AND relnamespace = 'public'::regnamespace);
