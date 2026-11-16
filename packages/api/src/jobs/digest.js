import { registerJob } from './queue.js';
import { formatDigestBody, ownerDigestSnapshot } from '../modules/dashboards/index.js';

registerJob('workspace_digest', async (client, payload, job) => {
  const timezone = payload?.timezone ?? 'Asia/Kolkata';
  const period = payload?.period;
  if (!period) throw new Error('workspace_digest requires period in payload');

  const snapshot = await ownerDigestSnapshot(client, job.workspace_id, timezone);
  if (snapshot.error) throw new Error(snapshot.error.message ?? 'digest snapshot failed');

  const body = formatDigestBody(snapshot, { period, timezone });

  const { rows: owner } = await client.query(
    `SELECT m.id AS membership_id, u.phone_e164
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.role = 'owner' AND m.state <> 'inactive'
     ORDER BY m.created_at
     LIMIT 1`,
  );

  if (owner[0]?.membership_id) {
    await client.query(
      `INSERT INTO notifications (membership_id, kind, body, channel)
       VALUES ($1, 'digest', $2, 'in_app')`,
      [owner[0].membership_id, body],
    );
  }

  if (owner[0]?.phone_e164) {
    await client.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1, $2, 'digest')`, [
      owner[0].phone_e164,
      body,
    ]);
  }

  return { body, snapshot };
});
