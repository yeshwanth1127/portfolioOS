SELECT to_regclass('public.jobs') IS NOT NULL AND to_regclass('public.calendar_events') IS NOT NULL
   AND to_regprocedure('auth.claim_jobs(text,integer)') IS NOT NULL
   AND to_regprocedure('auth.enqueue_job(text,jsonb,timestamp with time zone,text)') IS NOT NULL
   AND to_regprocedure('auth.cancel_queued_jobs(text)') IS NOT NULL
   AND to_regprocedure('auth.workspace_member_name(uuid)') IS NOT NULL;
