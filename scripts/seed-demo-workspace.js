#!/usr/bin/env node
/**
 * Seed a small demo workspace (Phase 8 onboarding / sales demos).
 * Usage: DATABASE_URL=postgresql://... node scripts/seed-demo-workspace.js
 */
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('Set DATABASE_URL or ADMIN_DATABASE_URL');
  process.exit(1);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hashPassword } = await import(path.join(repo, 'packages/api/src/core/passwords.js'));

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

try {
  const slug = process.env.DEMO_WORKSPACE_SLUG ?? 'demo-pilot';
  const email = process.env.DEMO_OWNER_EMAIL ?? 'owner@demo.pilot';
  const pw = await hashPassword(process.env.DEMO_OWNER_PASSWORD ?? 'demo-password-change-me');

  const ws = await client.query(
    `INSERT INTO workspaces (name, slug) VALUES ('Demo pilot', $1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [slug],
  );
  const workspaceId = ws.rows[0].id;
  await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [workspaceId]);

  const user = await client.query(
    `INSERT INTO users (full_name, email, password_hash) VALUES ('Demo Owner', $1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, pw],
  );
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, workspace_role) VALUES ($1,$2,'owner')
     ON CONFLICT DO NOTHING`,
    [workspaceId, user.rows[0].id],
  );
  await client.query(
    `INSERT INTO memberships (user_id, role, title, workspace_id, state)
     VALUES ($1,'owner','owner',$2,'active') ON CONFLICT DO NOTHING`,
    [user.rows[0].id, workspaceId],
  );
  await client.query(
    `INSERT INTO organisations (slug, name, short_name, sector, descriptor)
     VALUES ('demo','Demo Org','DEMO','Services','Demo workspace organisation')
     ON CONFLICT DO NOTHING`,
  );
  console.log(JSON.stringify({ workspace_id: workspaceId, slug, owner_email: email }, null, 2));
} finally {
  await client.end();
}
