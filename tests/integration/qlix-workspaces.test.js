import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

/*
 * One Qlix org per workspace (migration 024, modules/qlix): provisioning through Qlix's partner
 * API, resuming after a failure, credentials handed only to the runner, and owner-only status.
 * Qlix is replaced by a small fake that speaks the same endpoints.
 */
const fake = {
  tenants: new Map(), // externalOrgId → { orgId, apiKey, status }
  agents: [],
  tenantCalls: 0,
  failNextAgent: false,
  existingQlixEmails: new Set(['owner.b@test.local']), // already have a Qlix org of their own
  links: new Map(), // linkId → { linkId, orgId, orgName, externalOrgId, status, requestedByEmail }
  invitations: [],
  passwords: new Map(), // `${externalOrgId}:${email}` → password Qlix was given
};

function fakeQlix(req, res) {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method === 'POST' && req.url === '/api/v1/partners/tenants') {
      fake.tenantCalls += 1;
      if (req.headers.authorization !== 'Bearer partner-test-key') return send(401, { error: { code: 'unauthorized' } });
      if (fake.tenants.has(body.externalOrgId)) {
        return send(409, { error: { code: 'already_provisioned', message: 'exists' } });
      }
      if (fake.existingQlixEmails.has(String(body.ownerEmail).toLowerCase())) {
        return send(409, {
          error: {
            code: 'qlix_workspace_exists',
            message: 'already uses Qlix',
            connectUrl: 'http://localhost:3010/organization/plugins',
            pluginId: 'portfolio',
          },
        });
      }
      const t = { orgId: `org-${fake.tenants.size + 1}`, apiKey: `qlix_live_${body.externalOrgId}` };
      fake.tenants.set(body.externalOrgId, t);
      return send(201, { apiKey: t.apiKey, orgId: t.orgId, status: 'active' });
    }
    const rotate = /^\/api\/v1\/partners\/tenants\/([^/]+)\/rotate-key$/.exec(req.url);
    if (req.method === 'POST' && rotate) {
      const t = fake.tenants.get(decodeURIComponent(rotate[1]));
      t.apiKey = `${t.apiKey}-rotated`;
      return send(200, { apiKey: t.apiKey, orgId: t.orgId });
    }
    const complete = /^\/api\/v1\/partners\/links\/([^/]+)\/complete$/.exec(req.url);
    if (req.method === 'POST' && complete) {
      const link = fake.links.get(decodeURIComponent(complete[1]));
      if (!link) return send(404, { error: { code: 'not_found' } });
      if (link.status !== 'pending_link') return send(409, { error: { code: 'link_not_pending' } });
      if (link.externalOrgId && link.externalOrgId !== body.externalOrgId) {
        return send(409, { error: { code: 'external_org_mismatch' } });
      }
      link.externalOrgId = body.externalOrgId;
      link.status = 'active';
      const t = { orgId: link.orgId, apiKey: `qlix_live_link_${link.linkId}_${Date.now()}`, status: 'active' };
      fake.tenants.set(body.externalOrgId, t);
      return send(200, { apiKey: t.apiKey, orgId: t.orgId, externalOrgId: body.externalOrgId, status: 'active' });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/partners/links')) {
      const status = new URL(req.url, 'http://x').searchParams.get('status');
      return send(200, { links: [...fake.links.values()].filter((l) => !status || l.status === status) });
    }
    const pw = /^\/api\/v1\/partners\/tenants\/([^/]+)\/members\/password$/.exec(req.url);
    if (req.method === 'POST' && pw) {
      const ext = decodeURIComponent(pw[1]);
      const t = fake.tenants.get(ext);
      if (!t) return send(404, { error: { code: 'not_found' } });
      if (t.apiKey.startsWith('qlix_live_link_')) return send(403, { error: { code: 'not_partner_managed' } });
      fake.passwords.set(`${ext}:${body.email}`, body.password);
      return send(200, { ok: true });
    }
    const inv = /^\/api\/v1\/partners\/tenants\/([^/]+)\/invitations$/.exec(req.url);
    if (inv) {
      const ext = decodeURIComponent(inv[1]);
      if (req.method === 'GET') return send(200, { invitations: fake.invitations.filter((i) => i.ext === ext) });
      const i = {
        ext,
        invitationId: `inv-${fake.invitations.length + 1}`,
        email: body.email,
        role: body.role,
        status: 'pending',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: new Date().toISOString(),
      };
      fake.invitations.push(i);
      return send(201, { ...i, inviteToken: 'tok', inviteUrl: `http://localhost:3010/sign-in?invite=${i.invitationId}` });
    }
    if (req.method === 'POST' && req.url === '/api/v1/agents') {
      const tenant = [...fake.tenants.values()].find((t) => t.apiKey === req.headers['x-api-key']);
      if (!tenant) return send(401, { error: { code: 'unauthorized' } });
      if (fake.failNextAgent) {
        fake.failNextAgent = false;
        return send(503, { error: { code: 'inference_not_configured', message: 'try later' } });
      }
      const id = `agent-${fake.agents.length + 1}`;
      fake.agents.push({ id, orgId: tenant.orgId, name: body.name, runtime: body.runtime });
      return send(201, { agent: { id }, sdkAgentFile: { runner_token: `runner-${id}` } });
    }
    return send(404, { error: { code: 'not_found' } });
  });
}

let env;
let qlixServer;
let provision;

before(async () => {
  qlixServer = http.createServer(fakeQlix).listen(0);
  await new Promise((r) => qlixServer.once('listening', r));
  // Config is read at import time, so set it before the API loads.
  process.env.QLIX_BACKEND_URL = `http://127.0.0.1:${qlixServer.address().port}`;
  process.env.QLIX_PARTNER_KEY = 'partner-test-key';
  process.env.QLIX_SECRETS_KEY = 'test-secrets-key-0123456789abcdefghij';
  process.env.QLIX_WEBHOOK_SECRET = 'whsec_test';
  env = await createEnv();
  provision = await env.api('modules/qlix/provision.js');
});

after(async () => {
  await env.close();
  await new Promise((r) => qlixServer.close(r));
});

test('secrets round-trip and are not stored in clear text', async () => {
  const { encryptSecret, decryptSecret } = await env.api('core/secrets.js');
  const enc = encryptSecret('runner-abc');
  assert.notEqual(enc, 'runner-abc');
  assert.equal(decryptSecret(enc), 'runner-abc');
  assert.notEqual(encryptSecret('runner-abc'), enc, 'fresh IV each time');
});

test('a workspace gets one Qlix org with an Assistant, a Report writer and a Meeting Assistant, resuming after a failure', async () => {
  const ws = env.fx.wsA.id;
  fake.failNextAgent = true;
  await assert.rejects(provision.provisionWorkspace(ws));

  let { rows } = await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [ws]);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].tenant_key_enc, 'tenant key kept from the step that succeeded');
  assert.ok(!rows[0].tenant_key_enc.includes('qlix_live_'), 'tenant key encrypted');
  assert.equal(rows[0].assistant_agent_id, null);

  await provision.provisionWorkspace(ws);
  ({ rows } = await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [ws]));
  assert.equal(rows[0].status, 'active');
  assert.equal(fake.tenantCalls, 1, 'tenant created once, not again on retry');
  const orgAgents = fake.agents.filter((a) => a.orgId === rows[0].qlix_org_id);
  assert.deepEqual(orgAgents.map((a) => a.name).sort(), ['Assistant', 'Meeting Assistant', 'Report writer']);
  assert.ok(orgAgents.every((a) => a.runtime === 'hybrid'));

  // Running again changes nothing.
  await provision.provisionWorkspace(ws);
  assert.equal(fake.agents.filter((a) => a.orgId === rows[0].qlix_org_id).length, 3);
});

test('the runner gets this workspace\'s agent for the turn; the report profile gets the Report writer', async () => {
  const mint = async (body) => {
    const res = await fetch(`${env.base}/agent/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const { rows } = await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [env.fx.wsA.id]);

  const chat = await mint({ membership_id: env.fx.alphaManager.id, agent_id: 'x', message: 'hi', channel: 'web' });
  assert.equal(chat.qlix.agent_id, rows[0].assistant_agent_id);
  assert.equal(chat.qlix.runner_token, `runner-${rows[0].assistant_agent_id}`);
  assert.equal(chat.qlix.channel, 'web');

  const report = await mint({
    membership_id: env.fx.alphaManager.id,
    agent_id: 'x',
    message: 'draft',
    channel: 'report',
    profile: 'report',
    report_id: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(report.qlix.agent_id, rows[0].report_agent_id);

  // Workspace B has no Qlix org yet: no credentials, and never workspace A's.
  const other = await mint({ membership_id: env.fx.ownerB.id, agent_id: 'x', message: 'hi', channel: 'web' });
  assert.equal(other.qlix, null);
});

test('conversation ids are remembered per agent, channel and person', async () => {
  const res = await fetch(`${env.base}/agent/qlix/conversation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
    body: JSON.stringify({
      workspace_id: env.fx.wsA.id,
      agent_kind: 'assistant',
      channel: 'web',
      membership_id: env.fx.alphaManager.id,
      conversation_id: 'conv-1',
    }),
  });
  assert.equal(res.status, 200);
  const creds = await provision.runnerCredentials(env.fx.wsA.id, {
    channel: 'web',
    membershipId: env.fx.alphaManager.id,
  });
  assert.equal(creds.conversation_id, 'conv-1');
  const someoneElse = await provision.runnerCredentials(env.fx.wsA.id, {
    channel: 'web',
    membershipId: env.fx.owner.id,
  });
  assert.equal(someoneElse.conversation_id, null);
});

test('only the owner sees the Qlix status, and it never includes secrets', async () => {
  const owner = await env.http(env.fx.owner).get('/qlix/status');
  assert.equal(owner.status, 200);
  assert.equal(owner.body.status, 'active');
  assert.equal(owner.body.agents.length, 3);
  assert.ok(!JSON.stringify(owner.body).includes('runner-'), 'no runner tokens');
  assert.ok(!JSON.stringify(owner.body).includes('qlix_live_'), 'no tenant key');

  const manager = await env.http(env.fx.alphaManager).get('/qlix/status');
  assert.equal(manager.status, 403);

  // The table itself is invisible to non-owners, even inside their own workspace.
  const seen = await env.as(env.fx.alphaManager, (c) => c.query(`SELECT count(*)::int AS n FROM workspace_qlix`));
  assert.equal(seen.rows[0].n, 0);
});

test('the owner of a new Qlix org gets a one-time sign-in link; Qlix sends no email', async () => {
  const out = await env.http(env.fx.owner).post('/qlix/invite-owner');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(out.body.invite_url, /^http:\/\/localhost:3010\/sign-in/);
  const status = await env.http(env.fx.owner).get('/qlix/status');
  assert.equal(status.body.owner_invite.status, 'pending');

  // Qlix reports it accepted → Settings shows it on the next load.
  fake.invitations.at(-1).status = 'accepted';
  const after = await env.http(env.fx.owner).get('/qlix/status');
  assert.equal(after.body.owner_invite.status, 'accepted');

  const manager = await env.http(env.fx.alphaManager).post('/qlix/invite-owner');
  assert.equal(manager.status, 403);
});

function sign(body, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { raw, header: `t=${t},v1=${v1}` };
}

async function webhook(body, header) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${env.base}/qlix/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qlix-event': JSON.parse(raw).event, 'x-qlix-signature': header },
    body: raw,
  });
  return res.status;
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('an owner who already uses Qlix waits for the plugin, then the webhook links their existing org', async () => {
  const ws = env.fx.wsB.id;
  const row = await provision.provisionWorkspace(ws);
  assert.equal(row.status, 'waiting_link', 'not a failure');
  const status = await env.http(env.fx.ownerB).get('/qlix/status');
  assert.equal(status.body.connect_url, 'http://localhost:3010/organization/plugins');
  assert.equal(status.body.waiting_email, 'owner.b@test.local');

  const link = {
    linkId: 'link-1',
    orgId: 'org-existing-b',
    orgName: 'B Group',
    externalOrgId: null,
    status: 'pending_link',
    requestedByEmail: 'Owner.B@test.local',
  };
  fake.links.set(link.linkId, link);
  const body = { event: 'tenant.link_requested', ...link, sentAt: new Date().toISOString() };

  // Bad or stale signatures are refused.
  assert.equal(await webhook(body, 't=1,v1=00'), 401);
  assert.equal(await webhook(body, sign(body, 'wrong').header), 401);
  assert.equal(await webhook(body, sign(body, 'whsec_test', Math.floor(Date.now() / 1000) - 600).header), 401);

  const { raw, header } = sign(body);
  assert.equal(await webhook(raw, header), 202);
  const linked = await waitFor(async () => {
    const { rows } = await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [ws]);
    return rows[0]?.status === 'active' ? rows[0] : null;
  });
  assert.ok(linked, 'workspace became active');
  assert.equal(linked.link_mode, 'linked');
  assert.equal(linked.qlix_org_id, 'org-existing-b');
  assert.equal(fake.agents.filter((a) => a.orgId === 'org-existing-b').length, 3, 'all agents in their own org');

  // No owner invites for an org the customer already owns.
  const inv = await env.http(env.fx.ownerB).post('/qlix/invite-owner');
  assert.equal(inv.status, 409);
  assert.equal(inv.body.error.code, 'linked_org');
});

test('turning the plugin off pauses the workspace; turning it on again reuses the same agents', async () => {
  const ws = env.fx.wsB.id;
  const before = (await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [ws])).rows[0];

  const paused = { event: 'tenant.paused', linkId: 'link-1', orgId: 'org-existing-b', externalOrgId: ws };
  const p = sign(paused);
  assert.equal(await webhook(p.raw, p.header), 202);
  await waitFor(async () => (await env.sql(`SELECT status FROM workspace_qlix WHERE workspace_id = $1`, [ws])).rows[0].status === 'paused');

  const mint = await fetch(`${env.base}/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
    body: JSON.stringify({ membership_id: env.fx.ownerB.id, agent_id: 'x', message: 'hi', channel: 'web' }),
  }).then((r) => r.json());
  assert.equal(mint.qlix, null, 'no agent while paused');
  assert.equal(mint.qlix_state, 'paused');

  // Plugin back on: Qlix sends link_requested with our externalOrgId; missed webhook → the poll finds it.
  fake.links.get('link-1').status = 'pending_link';
  const agentsBefore = fake.agents.length;
  const out = await provision.syncQlixLinks();
  assert.equal(out.results[0].linked, true);
  const after = (await env.sql(`SELECT * FROM workspace_qlix WHERE workspace_id = $1`, [ws])).rows[0];
  assert.equal(after.status, 'active');
  assert.equal(after.assistant_agent_id, before.assistant_agent_id, 'same agents');
  assert.equal(fake.agents.length, agentsBefore, 'no new agents');
  assert.notEqual(after.tenant_key_enc, before.tenant_key_enc, 'new tenant key stored');
});

test('the owner sees their Qlix login and can set or generate a password; only on request, never for linked orgs', async () => {
  const owner = env.http(env.fx.owner);
  const status = await owner.get('/qlix/status');
  assert.equal(status.body.login.email, 'owner@test.local');
  assert.equal(status.body.login.password_known, false, 'first password was chosen in Qlix');
  assert.equal(status.body.org_name, 'Acme Group');

  const before = await owner.get('/qlix/login');
  assert.equal(before.status, 200);
  assert.equal(before.body.password, null);

  const typed = await owner.post('/qlix/login/password', { password: 'correct-horse-battery' });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(fake.passwords.get(`${env.fx.wsA.id}:owner@test.local`), 'correct-horse-battery', 'sent to Qlix');
  assert.equal((await owner.get('/qlix/login')).body.password, 'correct-horse-battery');

  const generated = await owner.post('/qlix/login/password', { password: '' });
  assert.equal(generated.status, 200);
  assert.ok(generated.body.password.length >= 16);
  assert.equal((await owner.get('/qlix/login')).body.password, generated.body.password);

  const short = await owner.post('/qlix/login/password', { password: 'short' });
  assert.equal(short.status, 400);
  const long = await owner.post('/qlix/login/password', { password: 'x'.repeat(73) });
  assert.equal(long.status, 400);
  assert.equal(long.body.error.code, 'password_too_long');

  // Stored encrypted; never in the status response; managers can't read or change it.
  const { rows } = await env.sql(`SELECT owner_password_enc FROM workspace_qlix WHERE workspace_id = $1`, [env.fx.wsA.id]);
  assert.ok(!rows[0].owner_password_enc.includes(generated.body.password));
  assert.ok(!JSON.stringify((await owner.get('/qlix/status')).body).includes(generated.body.password));
  assert.equal((await env.http(env.fx.alphaManager).get('/qlix/login')).status, 403);
  assert.equal((await env.http(env.fx.alphaManager).post('/qlix/login/password', {})).status, 403);

  // Workspace B is linked to the customer's own Qlix org: Orbit never sets that password.
  const linked = await env.http(env.fx.ownerB).post('/qlix/login/password', { password: 'another-long-password' });
  assert.equal(linked.status, 409);
  assert.equal(linked.body.error.code, 'not_partner_managed');
});

test('an active workspace from before the Meeting Assistant gets it on its first meeting run', async () => {
  await env.sql(`UPDATE workspace_qlix SET meeting_agent_id = NULL, meeting_runner_token_enc = NULL WHERE workspace_id = $1`, [env.fx.wsA.id]);
  const before = fake.agents.length;
  const { rows: m } = await env.sql(
    `INSERT INTO meetings (id, workspace_id, title, host_membership_id, room_name)
     VALUES (gen_random_uuid(), $1, 'Backfill', $2, 'orbit-' || gen_random_uuid()) RETURNING id`,
    [env.fx.wsA.id, env.fx.alphaManager.id],
  );
  const res = await fetch(`${env.base}/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
    body: JSON.stringify({ membership_id: env.fx.alphaManager.id, agent_id: 'x', message: 'm', channel: 'meeting', profile: 'meeting', meeting_id: m[0].id }),
  });
  const out = await res.json();
  assert.equal(fake.agents.length, before + 1, 'only the missing agent is created');
  assert.equal(fake.agents.at(-1).name, 'Meeting Assistant');
  const { rows } = await env.sql(`SELECT meeting_agent_id FROM workspace_qlix WHERE workspace_id = $1`, [env.fx.wsA.id]);
  assert.equal(out.qlix.agent_id, rows[0].meeting_agent_id);
  assert.equal(out.qlix.channel, 'meeting');
  assert.equal(out.qlix.meeting_id, m[0].id);
});
