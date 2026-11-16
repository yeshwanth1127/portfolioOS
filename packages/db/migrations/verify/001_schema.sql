-- true when the base schema from 001 is present
SELECT to_regclass('public.organisations') IS NOT NULL
   AND to_regclass('public.users') IS NOT NULL
   AND to_regclass('public.memberships') IS NOT NULL
   AND to_regclass('public.kpis') IS NOT NULL
   AND to_regclass('public.submissions') IS NOT NULL
   AND to_regclass('public.signoffs') IS NOT NULL
   AND to_regclass('public.scores') IS NOT NULL
   AND to_regclass('public.amendments') IS NOT NULL
   AND to_regclass('public.agent_sessions') IS NOT NULL
   AND to_regclass('public.wa_outbox') IS NOT NULL;
