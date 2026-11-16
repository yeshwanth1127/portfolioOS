import { pathToFileURL } from 'url';
import pg from 'pg';
import { hashPassword, verifyPassword } from '../../api/src/core/passwords.js';

/*
 * Local/demo convenience: every account still using the seeded password (`password123`, in the
 * legacy or the current format) gets DEMO_PASSWORD instead. Never touches other passwords.
 *   MIGRATION_DATABASE_URL=… DEMO_PASSWORD=… node set-demo-password.js
 */
export async function setDemoPassword(databaseUrl, demoPassword, seeded = 'password123') {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id, password_hash FROM users WHERE password_hash IS NOT NULL`);
    let changed = 0;
    const replacement = await hashPassword(demoPassword);
    for (const row of rows) {
      if ((await verifyPassword(seeded, row.password_hash)).ok) {
        await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [row.id, replacement]);
        changed += 1;
      }
    }
    return changed;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const pw = process.env.DEMO_PASSWORD;
  if (!pw) {
    console.log('[db] DEMO_PASSWORD not set — demo logins keep the seeded password');
    process.exit(0);
  }
  setDemoPassword(url, pw)
    .then((n) => console.log(`[db] demo logins updated: ${n}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
