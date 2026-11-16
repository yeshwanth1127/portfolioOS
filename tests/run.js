#!/usr/bin/env node
/**
 * Test runner. Starts a throwaway Postgres 16 container (or uses TEST_PG_ADMIN_URL if set),
 * runs every suite with node:test, then removes the container.
 *
 *   npm test                         all suites
 *   npm test -- tests/integration    one folder or file
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const root = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.TEST_PG_IMAGE ?? 'postgres:16-alpine';

async function waitForPostgres(url) {
  for (let i = 0; i < 60; i += 1) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Test Postgres did not become ready in 30s');
}

function testFiles(targets) {
  const out = [];
  const walk = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) fs.readdirSync(p).sort().forEach((f) => walk(path.join(p, f)));
    else if (p.endsWith('.test.js')) out.push(p);
  };
  targets.forEach(walk);
  return out;
}

let container = null;
let adminUrl = process.env.TEST_PG_ADMIN_URL;
if (!adminUrl) {
  container = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', IMAGE],
    { encoding: 'utf8' },
  ).trim();
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]
    .split(':')
    .pop();
  adminUrl = `postgresql://postgres:test@127.0.0.1:${port}/postgres`;
}

const cleanup = () => {
  if (container) {
    try {
      execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    container = null;
  }
};
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let code = 1;
try {
  await waitForPostgres(adminUrl);
  // Cluster-wide roles once; each test database is then owned by portfolio_migrator.
  const { bootstrapDatabase } = await import(path.join(root, '../packages/db/scripts/bootstrap.js'));
  await bootstrapDatabase({ adminUrl, migratorPassword: 'migrator', appPassword: 'app', log: () => {} });
  const args = process.argv.slice(2);
  const targets = (args.length ? args : ['integration', 'concurrency']).map((t) =>
    fs.existsSync(t) ? path.resolve(t) : path.join(root, t),
  );
  const files = testFiles(targets);
  if (!files.length) throw new Error('No *.test.js files found');
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', ...files], {
      stdio: 'inherit',
      env: { ...process.env, TEST_PG_ADMIN_URL: adminUrl, NODE_ENV: 'test' },
    });
    child.on('close', (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(e.message);
} finally {
  cleanup();
}
process.exit(code);
