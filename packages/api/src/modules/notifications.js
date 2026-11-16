/*
 * In-app notifications (the bell in the top bar). Rows are written by jobs in the system scope;
 * a person reads and clears only their own (RLS policy `mine`, 017_milestones_notifications.sql).
 * WhatsApp copies (channel 'whatsapp') are a delivery log and aren't shown here.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (code, message) => ({ error: { code, message } });

export async function listNotifications(client, membership, { limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const { rows } = await client.query(
    `SELECT n.id, n.kind, n.body, n.created_at, n.read_at, n.meeting_id,
            COALESCE(n.link,
              CASE WHEN n.task_id IS NOT NULL OR n.kind IN ('assigned', 'due_tomorrow', 'overdue') THEN '/my-work'
                   WHEN n.project_id IS NOT NULL THEN '/projects/' || n.project_id
                   WHEN n.kind = 'report' THEN '/reports'
              END) AS link,
            mt.status AS meeting_status, mt.title AS meeting_title, mt.starts_at AS meeting_starts_at
     FROM notifications n
     LEFT JOIN meetings mt ON mt.id = n.meeting_id
     WHERE n.membership_id = $1 AND n.channel = 'in_app'
     ORDER BY n.created_at DESC
     LIMIT $2`,
    [membership.id, n],
  );
  const { rows: count } = await client.query(
    `SELECT count(*)::int AS n FROM notifications WHERE membership_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
    [membership.id],
  );
  return { notifications: rows, unread: count[0].n };
}

/** Mark some (`ids`) or all (`all: true`) of the caller's notifications read. */
export async function markNotificationsRead(client, membership, body) {
  const all = body?.all === true;
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
  if (!all && (!ids.length || ids.some((id) => !UUID.test(id)))) return err('invalid', 'Say which notifications to mark read.');
  await client.query(
    `UPDATE notifications SET read_at = now()
     WHERE membership_id = $1 AND read_at IS NULL AND channel = 'in_app' AND ($2 OR id = ANY($3::uuid[]))`,
    [membership.id, all, ids],
  );
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM notifications WHERE membership_id = $1 AND channel = 'in_app' AND read_at IS NULL`,
    [membership.id],
  );
  return { unread: rows[0].n };
}
