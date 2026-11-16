-- One row per organisation-day. Every reporting operation (record, correct, withdraw, approve,
-- lock, reopen) locks this row first, so a submission can never slip into a day that is being
-- or has been locked. Also records who locked / reopened a day and why.

CREATE TABLE org_periods (
  org_id uuid NOT NULL REFERENCES organisations(id),
  period_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
  locked_by uuid REFERENCES memberships(id),
  locked_at timestamptz,
  reopened_by uuid REFERENCES memberships(id),
  reopened_at timestamptz,
  reopen_reason text,
  PRIMARY KEY (org_id, period_date)
);

INSERT INTO org_periods (org_id, period_date, status, locked_by, locked_at)
SELECT org_id, period_date, 'locked', manager_id, locked_at FROM signoffs
ON CONFLICT DO NOTHING;

-- Corrections are reviewed again instead of becoming an 'amended' (scored) value.
-- Any existing 'amended' rows go back to review.
UPDATE submissions SET state = 'submitted', validated_by = NULL, validated_at = NULL
WHERE state = 'amended';

ALTER TABLE org_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_scope_org_periods ON org_periods
  USING (
    current_setting('app.role', true) = 'owner'
    OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );

-- Withdrawing an unapproved number removes its correction notes with it.
ALTER TABLE amendments DROP CONSTRAINT amendments_submission_id_fkey;
ALTER TABLE amendments ADD CONSTRAINT amendments_submission_id_fkey
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE;
