-- Read-only workspace migration checks (see docs/SONA_MIGRATION.md).
-- Prefer: bash scripts/sona-workspace-reconcile.sh
-- Run with portfolio_migrator or superuser.

-- NULL workspace_id (should return zero rows for every line)
SELECT 'organisations' AS tbl, count(*) AS null_workspace FROM organisations WHERE workspace_id IS NULL
UNION ALL SELECT 'memberships', count(*) FROM memberships WHERE workspace_id IS NULL
UNION ALL SELECT 'kpis', count(*) FROM kpis WHERE workspace_id IS NULL
UNION ALL SELECT 'submissions', count(*) FROM submissions WHERE workspace_id IS NULL;

-- Sona workspace row count snapshot
SELECT w.slug, t.relname AS table_name, c.reltuples::bigint AS approx_rows
FROM workspaces w
CROSS JOIN LATERAL (
  SELECT c.oid, c.relname, c.reltuples
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
) t
JOIN pg_class c ON c.relname = t.relname AND c.relnamespace = 'public'::regnamespace
WHERE w.slug = 'sona'
ORDER BY t.relname;
