import { query } from '../db.js';

/** Run SQL on a transaction client (agent tools) or the pool (HTTP routes). */
export async function dbQuery(client, text, params) {
  if (client) return client.query(text, params);
  return query(text, params);
}
