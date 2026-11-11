-- Align stored bands with goal-only rule: green_at = target, amber_at = 80% (or 125% for lower_is_better).
UPDATE kpis
SET
  green_at = target,
  amber_at = CASE
    WHEN direction = 'lower_is_better' THEN round(target / 0.8, 2)
    ELSE round(target * 0.8, 2)
  END
WHERE target IS NOT NULL;
