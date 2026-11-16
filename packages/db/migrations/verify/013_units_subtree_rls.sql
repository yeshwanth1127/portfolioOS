SELECT to_regprocedure('auth.unit_in_org_tree(uuid,uuid,uuid)') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'units' AND policyname = 'visible'
  );
