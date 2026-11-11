import pg from 'pg';

// DATE columns as plain 'YYYY-MM-DD' (no timezone shift to the previous day in IST).
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://portfolio:portfolio@localhost:5432/portfolio_os',
});

export async function withSession(membership, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = membership.role;
    const orgId = membership.org_id ?? '';
    await client.query(`SELECT set_config('app.role', $1, true)`, [role]);
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [orgId]);
    await client.query(`SELECT set_config('app.membership_id', $1, true)`, [
      membership.id,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export { pool };
