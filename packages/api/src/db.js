import pg from 'pg';

// DATE columns as plain 'YYYY-MM-DD' (no timezone shift to the previous day in IST).
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://portfolio:portfolio@localhost:5432/portfolio_os',
});

/**
 * Run `fn` in one transaction scoped to the caller (role / org / membership for RLS).
 * The transaction is rolled back when `fn` throws OR returns a domain failure (`{ error }`),
 * so a function that writes and then reports an error never leaves partial changes.
 * Keep it short: database work only — never hold it across an agent turn or other network call.
 */
export async function withSession(membership, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The workspace is the hard boundary (restrictive RLS); without it nothing is visible.
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [membership.workspace_id ?? '']);
    await client.query(`SELECT set_config('app.role', $1, true)`, [membership.role]);
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [membership.org_id ?? '']);
    await client.query(`SELECT set_config('app.membership_id', $1, true)`, [membership.id]);
    const result = await fn(client);
    if (result && typeof result === 'object' && result.error) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Unscoped query. Only for paths that run before a caller is known (login, token → membership)
 * and for service jobs; request handlers use withSession.
 */
export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export { pool };
