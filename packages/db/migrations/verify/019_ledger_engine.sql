SELECT to_regclass('public.metrics') IS NOT NULL
  AND to_regclass('public.target_versions') IS NOT NULL
  AND to_regclass('public.reports') IS NOT NULL
  AND to_regclass('public.report_revisions') IS NOT NULL
  AND to_regclass('public.approvals') IS NOT NULL
  AND to_regclass('public.ledger_entries') IS NOT NULL
  AND to_regclass('public.ledger_source_claims') IS NOT NULL
  AND to_regclass('public.period_results') IS NOT NULL
  AND to_regclass('public.idempotency_keys') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'aggregation')
  AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'contributes_metric_id'
  )
  AND EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_entries_immutable'
  );
