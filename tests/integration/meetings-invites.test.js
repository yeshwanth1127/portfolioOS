import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

/*
 * Meetings are always with someone: people, a team (unit) or an organisation. Invitees get an
 * in-app notification (written by the meeting_notify job) that the bell lists and links to.
 */
let env;
let runDueJobs;
before(async () => {
  env = await createEnv();
  ({ runDueJobs } = await env.api('jobs/queue.js'));
});
after(async () => {
  await env.close();
});

/** Run the queued meeting_notify jobs now (the worker isn't running in tests). */
async function flushNotifications() {
  await env.sql(`UPDATE jobs SET run_at = now() WHERE kind = 'meeting_notify' AND done_at IS NULL AND failed_at IS NULL AND payload->>'kind' <> 'reminder'`);
  while ((await runDueJobs(50)) > 0) { /* drain */ }
}

const inbox = async (fx) => (await env.http(fx).get('/notifications')).body;

test('a meeting must say who it is with', async () => {
  const res = await env.http(env.fx.alphaManager).post('/meetings', { instant: true });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /who the meeting is with/i);
});

test('the invite directory is the whole workspace, for every role', async () => {
  for (const fx of [env.fx.owner, env.fx.alphaMember1]) {
    const dir = (await env.http(fx).get('/meetings/invitees')).body;
    const ids = dir.people.map((p) => p.id);
    assert.ok(ids.includes(env.fx.betaMember.id) && ids.includes(env.fx.alphaManager.id));
    assert.ok(!ids.includes(fx.id), 'you are not in your own list');
    assert.ok(!ids.includes(env.fx.gammaManager.id), 'nobody from another workspace');
    assert.ok(dir.orgs.some((o) => o.id === env.fx.beta.id && o.member_ids.includes(env.fx.betaMember.id)), 'other organisations, with their people');
    assert.ok(!dir.orgs.some((o) => o.id === env.fx.gamma.id));
    const branch = dir.teams.find((t) => t.id === env.fx.alphaBranch.id);
    assert.ok(branch?.member_ids.includes(env.fx.crossBranchManager.id), 'a unit lists the people assigned to it');
    assert.ok(dir.people.every((p) => !('phone_e164' in p)), 'no contact details');
  }
});

test('a member can schedule with another organisation; it goes on their calendar', async () => {
  const start = new Date(Date.now() + 5 * 3600000).toISOString();
  const res = await env.http(env.fx.alphaMember1).post('/meetings', { title: 'Cross-org', starts_at: start, org_ids: [env.fx.beta.id] });
  if (res.status !== 200) assert.fail(JSON.stringify(res.body));
  const m = res.body.meeting;
  assert.equal(m.org_id, env.fx.alpha.id, 'it still belongs to the host’s organisation');
  assert.ok(m.participants.some((p) => p.membership_id === env.fx.betaMember.id));
  assert.equal((await env.http(env.fx.betaMember).get(`/meetings/${m.id}`)).status, 200, 'invitees elsewhere can open it');
  const { rows } = await env.sql(`SELECT count(*)::int AS c FROM calendar_event_participants WHERE event_id = $1 AND membership_id = $2`, [m.calendar_event_id, env.fx.betaMember.id]);
  assert.equal(rows[0].c, 1);
  assert.equal((await env.http(env.fx.alphaMember1).delete(`/meetings/${m.id}`)).status, 200);
});

test('instant meeting with a whole organisation: everyone in it is invited and told to join', async () => {
  const created = await env.http(env.fx.owner).post('/meetings', { instant: true, title: 'Beta all-hands', org_ids: [env.fx.beta.id] });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const m = created.body.meeting;
  assert.equal(m.org_id, env.fx.beta.id, 'a meeting for one organisation belongs to it');
  const invited = m.participants.filter((p) => p.role === 'attendee').map((p) => p.membership_id);
  for (const fx of [env.fx.betaManager, env.fx.betaLead, env.fx.betaMember]) assert.ok(invited.includes(fx.id));
  assert.ok(!invited.includes(env.fx.alphaMember1.id));
  assert.equal(created.body.invited, invited.length);

  await flushNotifications();
  const box = await inbox(env.fx.betaMember);
  const n = box.notifications.find((x) => x.meeting_id === m.id);
  assert.ok(n, 'the invitee is notified');
  assert.equal(n.kind, 'meeting_started');
  assert.match(n.body, /started a meeting with you: Beta all-hands/);
  assert.equal(n.link, `/meetings/${m.id}?join=1`);
  assert.equal(n.meeting_status, 'scheduled');
  assert.ok(box.unread >= 1);
  assert.equal((await inbox(env.fx.owner)).notifications.filter((x) => x.meeting_id === m.id).length, 0, 'the host is not notified');

  // Reading: one, then all; and nobody can mark someone else's.
  const other = await env.http(env.fx.alphaMember1).post('/notifications/read', { ids: [n.id] });
  assert.equal(other.status, 200);
  assert.equal((await inbox(env.fx.betaMember)).notifications.find((x) => x.id === n.id).read_at, null);
  const read = await env.http(env.fx.betaMember).post('/notifications/read', { ids: [n.id] });
  assert.equal(read.body.unread, box.unread - 1);
  await env.http(env.fx.betaMember).post('/notifications/read', { all: true });
  assert.equal((await inbox(env.fx.betaMember)).unread, 0);
  assert.equal((await env.http(env.fx.betaMember).post('/notifications/read', {})).status, 400);
});

test('scheduled meeting with a team, then more people added; cancelling tells them', async () => {
  const start = new Date(Date.now() + 3 * 3600000).toISOString();
  const created = await env.http(env.fx.owner).post('/meetings', {
    title: 'North review',
    starts_at: start,
    duration_minutes: 30,
    team_ids: [env.fx.alphaBranch.id],
  });
  if (created.status !== 200) assert.fail(JSON.stringify(created.body));
  const m = created.body.meeting;
  assert.ok(m.participants.some((p) => p.membership_id === env.fx.crossBranchManager.id));
  const { rows: reminder } = await env.sql(
    `SELECT run_at FROM jobs WHERE kind = 'meeting_notify' AND dedupe_key = $1 AND done_at IS NULL AND failed_at IS NULL`,
    [`meeting:${m.id}:reminder`],
  );
  assert.equal(reminder.length, 1, 'a reminder is queued for 10 minutes before');

  await flushNotifications();
  const n = (await inbox(env.fx.crossBranchManager)).notifications.find((x) => x.meeting_id === m.id);
  assert.equal(n.kind, 'meeting_invited');
  assert.match(n.body, /invited you to North review/);
  assert.equal(n.link, `/meetings/${m.id}`);

  // The team member can open the link; someone not invited in another org cannot.
  assert.equal((await env.http(env.fx.crossBranchManager).get(`/meetings/${m.id}`)).status, 200);
  assert.equal((await env.http(env.fx.betaMember).get(`/meetings/${m.id}`)).status, 404);

  // Only a manager of the meeting may invite more; then Beta Member is in, and on the calendar.
  assert.equal((await env.http(env.fx.crossBranchManager).post(`/meetings/${m.id}/participants`, { participant_ids: [env.fx.betaMember.id] })).status, 403);
  const added = await env.http(env.fx.owner).post(`/meetings/${m.id}/participants`, { participant_ids: [env.fx.betaMember.id, env.fx.crossBranchManager.id] });
  if (added.status !== 200) assert.fail(JSON.stringify(added.body));
  assert.equal(added.body.invited, 1, 'people already invited are not invited twice');
  assert.equal((await env.http(env.fx.betaMember).get(`/meetings/${m.id}`)).status, 200);
  const { rows: cal } = await env.sql(`SELECT membership_id FROM calendar_event_participants WHERE event_id = $1`, [m.calendar_event_id]);
  assert.ok(cal.some((r) => r.membership_id === env.fx.betaMember.id));
  await flushNotifications();
  assert.ok((await inbox(env.fx.betaMember)).notifications.some((x) => x.meeting_id === m.id && x.kind === 'meeting_invited'));
  assert.equal(
    (await inbox(env.fx.crossBranchManager)).notifications.filter((x) => x.meeting_id === m.id).length,
    1,
    'no second invite for someone already invited',
  );

  assert.equal((await env.http(env.fx.owner).delete(`/meetings/${m.id}`)).status, 200);
  await flushNotifications();
  const cancelled = (await inbox(env.fx.betaMember)).notifications.find((x) => x.kind === 'meeting_cancelled');
  assert.match(cancelled.body, /cancelled North review/);
  assert.equal(cancelled.link, null);
  const { rows: left } = await env.sql(`SELECT count(*)::int AS c FROM jobs WHERE dedupe_key = $1 AND done_at IS NULL AND failed_at IS NULL`, [`meeting:${m.id}:reminder`]);
  assert.equal(left[0].c, 0, 'the reminder is cancelled');
});

test('the 10-minute reminder goes to the host and everyone invited', async () => {
  const start = new Date(Date.now() + 3 * 3600000).toISOString();
  const { body } = await env.http(env.fx.alphaManager).post('/meetings', {
    title: 'Planning',
    starts_at: start,
    participant_ids: [env.fx.alphaMember1.id],
  });
  const m = body.meeting;
  await flushNotifications();
  await env.sql(`UPDATE jobs SET run_at = now() WHERE dedupe_key = $1`, [`meeting:${m.id}:reminder`]);
  await runDueJobs(50);
  for (const fx of [env.fx.alphaManager, env.fx.alphaMember1]) {
    const r = (await inbox(fx)).notifications.find((x) => x.meeting_id === m.id && x.kind === 'meeting_reminder');
    assert.ok(r, 'host and invitee get the reminder');
    assert.match(r.body, /Planning starts in 10 minutes/);
  }
});

test('people and groups from another workspace cannot be invited', async () => {
  const person = await env.http(env.fx.alphaMember1).post('/meetings', { instant: true, participant_ids: [env.fx.gammaManager.id] });
  assert.equal(person.status, 400);
  const org = await env.http(env.fx.alphaMember1).post('/meetings', { instant: true, org_ids: [env.fx.gamma.id] });
  assert.equal(org.status, 400);
});

test('only the person who started a meeting can end or cancel it', async () => {
  const start = new Date(Date.now() + 4 * 3600000).toISOString();
  const scheduled = (await env.http(env.fx.alphaMember1).post('/meetings', { title: 'Mine', starts_at: start, participant_ids: [env.fx.alphaManager.id] })).body.meeting;
  assert.equal(scheduled.can_end, true);
  for (const fx of [env.fx.owner, env.fx.alphaManager]) {
    assert.equal((await env.http(fx).get(`/meetings/${scheduled.id}`)).body.meeting.can_end, false);
    const res = await env.http(fx).delete(`/meetings/${scheduled.id}`);
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /Only the person who started this meeting/);
  }
  assert.equal((await env.http(env.fx.alphaMember1).delete(`/meetings/${scheduled.id}`)).status, 200);

  const live = (await env.http(env.fx.alphaManager).post('/meetings', { instant: true, participant_ids: [env.fx.alphaMember1.id] })).body.meeting;
  assert.equal((await env.http(env.fx.owner).post(`/meetings/${live.id}/end`, {})).status, 403);
  assert.equal((await env.http(env.fx.alphaMember1).post(`/meetings/${live.id}/end`, {})).status, 403);
  assert.equal((await env.http(env.fx.alphaManager).post(`/meetings/${live.id}/end`, {})).status, 200);
});
