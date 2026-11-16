import assert from 'node:assert/strict';
import pg from 'pg';
import { after, before, test } from 'node:test';
import {
  captureBaseline,
  compareBaseline,
  integrityChecks,
} from '../../packages/db/scripts/sona-workspace-reconcile.js';
import { createEnv } from '../helpers/env.js';

let env;
let migratorUrl;

before(async () => {
  env = await createEnv();
  migratorUrl = new URL(env.adminUrl);
  migratorUrl.username = 'portfolio_migrator';
  migratorUrl.password = 'migrator';
});

after(async () => {
  await env.close();
});

async function withMigrator(fn) {
  const client = new pg.Client({ connectionString: migratorUrl.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test('reconcile integrity passes on migrated test fixtures', async () => {
  const failures = await withMigrator((c) => integrityChecks(c, { expectSona: false }));
  assert.deepEqual(failures, []);
});

test('baseline capture round-trip matches on fixture database', async () => {
  await withMigrator(async (c) => {
    const snap = await captureBaseline(c);
    const { failures } = await compareBaseline(c, snap, { expectSona: false });
    assert.deepEqual(failures, []);
  });
});
