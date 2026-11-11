-- Row-level security (submissions + activity_entries; API sets session vars)

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpis ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_scope_submissions ON submissions
  USING (
    current_setting('app.role', true) = 'owner'
    OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );

CREATE POLICY subtree_scope_activity ON activity_entries
  USING (
    current_setting('app.role', true) IN ('owner', 'manager', 'vice_manager', 'team_lead')
    OR membership_id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM memberships
        WHERE id = NULLIF(current_setting('app.membership_id', true), '')::uuid
        UNION ALL
        SELECT m.id FROM memberships m JOIN sub ON m.parent_id = sub.id
      )
      SELECT id FROM sub
    )
  );

CREATE POLICY org_scope_kpis ON kpis
  USING (
    current_setting('app.role', true) = 'owner'
    OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );

CREATE POLICY org_scope_scores ON scores
  USING (
    current_setting('app.role', true) = 'owner'
    OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );
