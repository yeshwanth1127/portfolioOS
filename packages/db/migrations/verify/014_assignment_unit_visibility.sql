SELECT to_regprocedure('auth.unit_on_assignment_chain(uuid,uuid)') IS NOT NULL
  AND to_regprocedure('auth.actor_secondary_assignment_unit_ids()') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'units' AND policyname = 'visible'
  )
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'assignments' AND policyname = 'visible'
  );
