SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'role_level' AND e.enumlabel = 'manager')
   AND EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'role_level' AND e.enumlabel = 'team_lead')
   AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                   WHERE t.typname = 'role_level' AND e.enumlabel = 'lead')
   AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'signoffs' AND column_name = 'manager_id')
   AND to_regclass('public.one_manager_per_org') IS NOT NULL;
