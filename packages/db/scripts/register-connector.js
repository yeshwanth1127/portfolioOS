import pg from 'pg';

/*
 * Local convenience: attach the WhatsApp connector in WA_CONNECTOR_ID to a workspace
 * (default "sona"). In the product the owner does this from Settings → WhatsApp.
 *   MIGRATION_DATABASE_URL=… WA_CONNECTOR_ID=… node register-connector.js [workspace-slug]
 */
const connector = process.env.WA_CONNECTOR_ID;
const slug = process.argv[2] ?? 'sona';
if (!connector) {
  console.log('[db] WA_CONNECTOR_ID not set — no WhatsApp connector registered');
  process.exit(0);
}
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    `INSERT INTO whatsapp_connections (workspace_id, connector_id)
     SELECT id, $1 FROM workspaces WHERE slug = $2
     ON CONFLICT (connector_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
     RETURNING workspace_id`,
    [connector, slug],
  );
  console.log(rows[0] ? `[db] WhatsApp connector registered to workspace "${slug}"` : `[db] no workspace "${slug}"`);
} finally {
  await client.end();
}
