import assert from 'node:assert/strict';
import http from 'http';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';
import { resolveSender } from '../../services/wa-gateway/src/identity.js';
import { isDeliveryIntent } from '../../services/wa-gateway/src/app.js';

/*
 * WhatsApp identity (F10): a sender is the owner only when the sidecar forwarded the owner's own
 * chat; contacts are trusted only by phone JID; anything else is rejected without an agent run.
 */
const SECRET = 's'.repeat(40);
const LINKED = '919800000001:12@s.whatsapp.net';
let env, gw, server, base, runner, runnerCalls;

before(async () => {
  env = await createEnv();
  await env.sql(`UPDATE users SET phone_e164 = '+919800000001' WHERE email = 'owner@test.local'`);
  await env.sql(`UPDATE users SET phone_e164 = '+919800000002' WHERE email = 'alpha.member.one@test.local'`);
  await env.sql(`UPDATE users SET phone_e164 = '+919800000009' WHERE email = 'owner.b@test.local'`);
  await env.sql(`INSERT INTO whatsapp_connections (workspace_id, connector_id) VALUES ($1, 'conn-1')`, [env.fx.wsA.id]);
  // A fake agent-runner that records who it was asked to run as.
  runnerCalls = [];
  runner = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      runnerCalls.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reply: 'ok from agent' }));
    });
  }).listen(0);
  const { createGateway } = await import('../../services/wa-gateway/src/app.js');
  gw = createGateway({
    databaseUrl: env.appUrl,
    runnerUrl: `http://127.0.0.1:${runner.address().port}`,
    runnerSecret: SECRET,
    serviceSecret: SECRET,
    connectorId: 'conn-1',
  });
  server = gw.app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  runner.close();
  await gw.close();
  await env.close();
});

const post = (path, body, secret = SECRET) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-secret': secret }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
const inbound = (body) => post('/api/v1/whatsapp/inbound', { connector_id: 'conn-1', ...body });
const ownerMembershipId = async () => (await env.sql(`SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'owner@test.local'`)).rows[0].id;

test('delivery intent helper', () => {
  assert.equal(isDeliveryIntent('@ complete my task'), true);
  assert.equal(isDeliveryIntent('hello'), false);
});

test('identity rules', () => {
  assert.deepEqual(resolveSender({}, null), { ok: false, reason: 'link_unknown' });
  assert.deepEqual(resolveSender({}, LINKED), { ok: true, phone: '+919800000001', selfChat: true });
  assert.deepEqual(resolveSender({ from_contact: true, remote_jid: '919800000002@s.whatsapp.net' }, LINKED), { ok: true, phone: '+919800000002', selfChat: false });
  assert.equal(resolveSender({ from_contact: true, remote_jid: '123456789@lid' }, LINKED).reason, 'unverified_sender');
  assert.equal(resolveSender({ from_contact: true, remote_jid: '1203630@g.us' }, LINKED).reason, 'unsupported_chat');
});

test('the old unauthenticated /inbound route is gone; inbound needs the service secret', async () => {
  const old = await fetch(`${base}/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone_e164: '+919800000001', text: '@ hi' }) });
  assert.equal(old.status, 404);
  assert.equal((await post('/api/v1/whatsapp/inbound', { text: '@ hi' }, 'wrong')).status, 401);
});

test('before the link is confirmed, a self-chat message is rejected (no owner fallback)', async () => {
  const r = await inbound({ text: '@ readiness' });
  assert.equal(r.body.handled, false);
  assert.equal(r.body.reason, 'link_unknown');
  assert.equal(runnerCalls.length, 0);
});

test('a LID contact is never treated as the owner', async () => {
  await post('/api/v1/internal/whatsapp/conn-1/linked', { owner_jid: LINKED });
  const r = await inbound({ text: '@ show everything', from_contact: true, remote_jid: '5551234@lid' });
  assert.equal(r.body.reason, 'unverified_sender');
  assert.equal(runnerCalls.length, 0);
});

test('an unregistered phone gets a fixed reply and no agent run', async () => {
  const r = await inbound({ text: '@ readiness', from_contact: true, remote_jid: '447700900123@s.whatsapp.net' });
  assert.equal(r.body.reason, 'not_registered');
  assert.match(r.body.reply, /not registered/);
  assert.equal(runnerCalls.length, 0);
});

test('self-chat runs as the owner; a registered contact runs as themselves', async () => {
  const self = await inbound({ text: '@ readiness' });
  assert.equal(self.body.handled, true);
  assert.equal(self.body.deliver_to, 'self');
  assert.equal(runnerCalls.at(-1).membership_id, await ownerMembershipId());

  const contact = await inbound({ text: '@ my numbers', from_contact: true, remote_jid: '919800000002@s.whatsapp.net' });
  assert.equal(contact.body.handled, true);
  assert.equal(contact.body.deliver_to, 'contact');
  const member = (await env.sql(`SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'alpha.member.one@test.local'`)).rows[0].id;
  assert.equal(runnerCalls.at(-1).membership_id, member);
  assert.equal(runnerCalls.at(-1).agent_id, 'portfolio-reporter-agent');
});

test("another workspace's member cannot use this workspace's WhatsApp connection", async () => {
  const before = runnerCalls.length;
  const r = await inbound({ text: '@ readiness', from_contact: true, remote_jid: '919800000009@s.whatsapp.net' });
  assert.equal(r.body.reason, 'not_registered');
  assert.equal(runnerCalls.length, before);
});

test('messages without @ are ignored; unknown connectors are refused', async () => {
  const before = runnerCalls.length;
  assert.equal((await inbound({ text: 'hello' })).body.reason, 'no_trigger');
  assert.equal((await post('/api/v1/whatsapp/inbound', { connector_id: 'someone-else', text: '@ hi' })).status, 404);
  assert.equal(runnerCalls.length, before);
});
