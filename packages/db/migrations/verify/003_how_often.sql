SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'how_often')
   AND EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'kpis' AND column_name = 'how_often')
   AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'kpis' AND column_name = 'cadence');
