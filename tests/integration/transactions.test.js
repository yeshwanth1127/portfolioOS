import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
before(async () => { env = await createEnv(); });
after(async () => { await env.close(); });

const countOrgs = async () => (await env.sql(`SELECT count(*)::int AS c FROM organisations`)).rows[0].c;
const insertOrg = (client, slug) =>
  client.query(
    `INSERT INTO organisations (slug, name, short_name, sector, descriptor) VALUES ($1,$1,$1,'x','x')`,
    [slug],
  );

test('a returned { error } rolls the transaction back', async () => {
  const before = await countOrgs();
  const out = await env.as(env.fx.owner, async (client) => {
    await insertOrg(client, 'half-done');
    return { error: { code: 'invalid', message: 'changed my mind' } };
  });
  assert.equal(out.error.code, 'invalid');
  assert.equal(await countOrgs(), before);
});

test('a thrown error rolls the transaction back', async () => {
  const before = await countOrgs();
  await assert.rejects(
    env.as(env.fx.owner, async (client) => {
      await insertOrg(client, 'thrown');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await countOrgs(), before);
});

test('a successful result commits', async () => {
  const before = await countOrgs();
  await env.as(env.fx.owner, async (client) => {
    await insertOrg(client, 'kept');
    return { ok: true };
  });
  assert.equal(await countOrgs(), before + 1);
});

test('an unhandled route error becomes a clean 500, and the API keeps serving', async () => {
  // A malformed id reaches Postgres on this legacy route and throws; the safety net must catch it.
  const res = await env.http(env.fx.owner).patch('/people/not-a-uuid', { title: 'x' });
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, 'internal');
  assert.equal((await env.http(env.fx.owner).get('/orgs')).status, 200);
});
