-- data-only migration: bands follow the goal for every KPI that has one
SELECT NOT EXISTS (SELECT 1 FROM kpis WHERE target IS NOT NULL AND green_at IS DISTINCT FROM target);
