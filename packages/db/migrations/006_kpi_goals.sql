-- A KPI can be tracked at several cadences (day / week / month / quarter), each with its own goal.
-- kpis.how_often stays the base cadence (how often a number is submitted = the most frequent tracked one);
-- kpis.target mirrors the base cadence goal for older readers.

CREATE TABLE IF NOT EXISTS kpi_goals (
  kpi_id uuid NOT NULL REFERENCES kpis(id) ON DELETE CASCADE,
  how_often how_often NOT NULL,
  target numeric,
  updated_by uuid REFERENCES memberships(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kpi_id, how_often)
);

INSERT INTO kpi_goals (kpi_id, how_often, target)
SELECT id, how_often, target FROM kpis
ON CONFLICT DO NOTHING;

-- One score row per KPI, as-of day and cadence (period-to-date for week/month/quarter).
ALTER TABLE scores ADD COLUMN IF NOT EXISTS how_often how_often;
UPDATE scores s SET how_often = k.how_often FROM kpis k WHERE k.id = s.kpi_id AND s.how_often IS NULL;
ALTER TABLE scores ALTER COLUMN how_often SET NOT NULL;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS goal numeric;
ALTER TABLE scores ADD COLUMN IF NOT EXISTS paced_goal numeric;
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_kpi_id_period_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS scores_kpi_period_cadence ON scores (kpi_id, period_date, how_often);
