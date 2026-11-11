-- Replace cadence (daily/weekly/…) with how_often labels shown in the UI.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'how_often') THEN
    CREATE TYPE how_often AS ENUM (
      'Every day',
      'Every week',
      'Every month',
      'Every quarter'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'kpis' AND column_name = 'cadence'
  ) THEN
    ALTER TABLE kpis ADD COLUMN IF NOT EXISTS how_often how_often;

    UPDATE kpis
    SET how_often = CASE cadence::text
      WHEN 'daily' THEN 'Every day'::how_often
      WHEN 'weekly' THEN 'Every week'::how_often
      WHEN 'monthly' THEN 'Every month'::how_often
      WHEN 'quarterly' THEN 'Every quarter'::how_often
    END
    WHERE how_often IS NULL;

    ALTER TABLE kpis ALTER COLUMN how_often SET NOT NULL;
    ALTER TABLE kpis DROP COLUMN cadence;
    DROP TYPE cadence;
  END IF;
END $$;
