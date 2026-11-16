SELECT to_regtype('unit_type') IS NOT NULL
  AND to_regclass('public.units') IS NOT NULL
  AND to_regclass('public.assignments') IS NOT NULL
  AND to_regclass('public.invitations') IS NOT NULL
  AND to_regprocedure('check_unit_parent_type()') IS NOT NULL
  AND to_regprocedure('auth.sync_units_from_legacy()') IS NOT NULL;
