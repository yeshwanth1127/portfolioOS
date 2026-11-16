import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';
import { INPUT_SCHEMA_BY_ACTION } from '../../packages/api/src/agent-tool-schemas.js';

let env;
before(async () => {
  env = await createEnv();
});
after(async () => {
  await env.close();
});

test('agent tool catalogue exposes input_schema for every action', async () => {
  const catalog = (await env.http(env.fx.owner).get('/agent/tools/catalog')).body;
  assert.equal(catalog.capability, 'portfolio_os');
  const actions = new Set(catalog.tools.map((tool) => tool.action));
  for (const action of Object.keys(INPUT_SCHEMA_BY_ACTION)) {
    assert.ok(actions.has(action), `catalog missing ${action}`);
  }
  for (const tool of catalog.tools) {
    assert.equal(tool.input_schema?.type, 'object', tool.action);
    if (tool.mutating) assert.ok(tool.requires, `${tool.action} should declare requires`);
  }
});
