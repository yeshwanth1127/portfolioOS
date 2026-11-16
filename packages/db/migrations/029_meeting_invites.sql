-- Meeting invites (docs/MEETINGS.md): in-app notifications can point at a meeting, and any
-- notification can carry an in-app link (a path such as /meetings/<id>) the bell opens.

ALTER TABLE notifications
  ADD COLUMN meeting_id uuid,
  ADD COLUMN link text CHECK (link IS NULL OR (link ~ '^/[A-Za-z0-9/_?=&.-]*$' AND length(link) <= 300)),
  ADD CONSTRAINT notifications_meeting_fk FOREIGN KEY (workspace_id, meeting_id)
    REFERENCES meetings (workspace_id, id) ON DELETE SET NULL (meeting_id);

CREATE INDEX notifications_unread_idx ON notifications (workspace_id, membership_id)
  WHERE read_at IS NULL AND channel = 'in_app';
