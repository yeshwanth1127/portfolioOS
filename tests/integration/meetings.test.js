import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createEnv } from '../helpers/env.js';

let env;
before(async () => {
  env = await createEnv();
});
after(async () => {
  await env.close();
});

/** Sign a webhook body the way LiveKit does (dev key pair used outside production). */
function livekitPost(event) {
  const body = JSON.stringify(event);
  const sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const token = jwt.sign({ sha256 }, 'secret', { algorithm: 'HS256', issuer: 'devkey', expiresIn: 60 });
  return fetch(`${env.base}/livekit/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/webhook+json', authorization: token },
    body,
  });
}

test('schedule a meeting: calendar event, invitees, visibility', async () => {
  const start = new Date(Date.now() + 2 * 3600000).toISOString();
  const created = await env.http(env.fx.alphaManager).post('/meetings', {
    title: 'Weekly sync',
    starts_at: start,
    duration_minutes: 30,
    participant_ids: [env.fx.alphaMember1.id],
  });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const m = created.body.meeting;
  assert.equal(m.status, 'scheduled');
  assert.equal(m.org_id, env.fx.alpha.id);
  assert.ok(m.calendar_event_id, 'scheduled meetings go on the calendar');
  assert.equal(m.room_name, undefined, 'room name is not exposed');
  assert.deepEqual(
    m.participants.map((p) => [p.membership_id, p.role]).sort(),
    [[env.fx.alphaManager.id, 'host'], [env.fx.alphaMember1.id, 'attendee']].sort(),
  );

  const { rows } = await env.sql(`SELECT kind, location FROM calendar_events WHERE id = $1`, [m.calendar_event_id]);
  assert.equal(rows[0].kind, 'meeting');
  assert.equal(rows[0].location, `/meetings/${m.id}`);

  // Same org and the owner see it; another org does not.
  const seenBy = async (fx) => (await env.http(fx).get('/meetings')).body.meetings.some((x) => x.id === m.id);
  assert.ok(await seenBy(env.fx.owner));
  assert.ok(await seenBy(env.fx.alphaMember2));
  assert.equal(await seenBy(env.fx.betaMember), false);
  assert.equal((await env.http(env.fx.betaMember).get(`/meetings/${m.id}`)).status, 404);
  assert.equal((await env.http(env.fx.betaMember).post(`/meetings/${m.id}/token`, {})).status, 404);

  // Only the host (or owner / org manager) may cancel.
  assert.equal((await env.http(env.fx.alphaMember1).delete(`/meetings/${m.id}`)).status, 403);
  assert.equal((await env.http(env.fx.alphaManager).delete(`/meetings/${m.id}`)).status, 200);
  const { rows: gone } = await env.sql(`SELECT count(*)::int AS c FROM calendar_events WHERE id = $1`, [m.calendar_event_id]);
  assert.equal(gone[0].c, 0);
});

test('instant meeting: join token, webhooks, end', async () => {
  const created = await env.http(env.fx.owner).post('/meetings', {
    instant: true,
    participant_ids: [env.fx.betaMember.id],
  });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const m = created.body.meeting;
  assert.equal(m.title, 'Instant meeting');
  assert.equal(m.calendar_event_id, null);

  // An invitee from another org can join; the token is a LiveKit grant for this room only.
  const joined = await env.http(env.fx.betaMember).post(`/meetings/${m.id}/token`, {});
  if (joined.status !== 200) assert.fail(JSON.stringify(joined.body));
  const claims = jwt.verify(joined.body.token, 'secret', { issuer: 'devkey' });
  assert.equal(claims.sub, env.fx.betaMember.id);
  assert.equal(claims.video.room, `orbit-${m.id}`);
  assert.equal(claims.video.roomJoin, true);
  assert.ok(joined.body.url.startsWith('ws'));
  assert.equal((await env.http(env.fx.owner).get(`/meetings/${m.id}`)).body.meeting.status, 'live');

  // Someone not invited and outside the meeting's scope cannot.
  assert.equal((await env.http(env.fx.alphaMember1).post(`/meetings/${m.id}/token`, {})).status, 404);

  // Webhooks: unsigned is refused; signed participant_left / room_finished update the meeting.
  const unsigned = await fetch(`${env.base}/livekit/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/webhook+json' },
    body: JSON.stringify({ event: 'room_finished', room: { name: `orbit-${m.id}` } }),
  });
  assert.equal(unsigned.status, 401);

  const left = await livekitPost({ event: 'participant_left', room: { name: `orbit-${m.id}` }, participant: { identity: env.fx.betaMember.id } });
  assert.equal(left.status, 200);
  const after1 = (await env.http(env.fx.owner).get(`/meetings/${m.id}`)).body.meeting;
  assert.ok(after1.participants.find((p) => p.membership_id === env.fx.betaMember.id).left_at);
  assert.equal(after1.in_call, 0);

  assert.equal((await env.http(env.fx.betaMember).post(`/meetings/${m.id}/end`, {})).status, 403);
  const ended = await env.http(env.fx.owner).post(`/meetings/${m.id}/end`, {});
  assert.equal(ended.status, 200);
  assert.equal(ended.body.meeting.status, 'ended');
  assert.equal((await env.http(env.fx.betaMember).post(`/meetings/${m.id}/token`, {})).status, 409);

  const finished = await livekitPost({ event: 'room_finished', room: { name: `orbit-${m.id}` } });
  assert.equal(finished.status, 200);
});

test('webhook for a room that is not ours is ignored', async () => {
  const res = await livekitPost({ event: 'room_started', room: { name: 'someone-else' } });
  assert.equal(res.status, 200);
});
