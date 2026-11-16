/**
 * Period lock. Call first, inside the transaction, before reading any submission or sign-off
 * state for that organisation-day. It serialises submit / correct / approve / lock / reopen,
 * so none of them can act on a stale view of whether the day is closed.
 *
 * @returns {'open' | 'locked'} the day's status, with the row locked until commit/rollback.
 */
export async function lockPeriod(client, orgId, periodDate) {
  await client.query(
    `INSERT INTO org_periods (org_id, period_date) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [orgId, periodDate],
  );
  const { rows } = await client.query(
    `SELECT status FROM org_periods WHERE org_id = $1 AND period_date = $2 FOR UPDATE`,
    [orgId, periodDate],
  );
  return rows[0].status;
}

export const DAY_LOCKED = {
  error: { code: 'locked', message: 'This day is locked. Ask the owner or manager to reopen it first.' },
};
