import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let meeting;
let room;
before(async () => {
  env = await createEnv();
  // Alpha manager hosts, Alpha Member One is invited; Beta Member is in another org.
  const created = await env.http(env.fx.alphaManager).post('/meetings', {
    instant: true,
    title: 'Hiring sync',
    participant_ids: [env.fx.alphaMember1.id],
  });
  meeting = created.body.meeting;
  room = `orbit-${meeting.id}`;
  await env.http(env.fx.alphaManager).post(`/meetings/${meeting.id}/token`, {});
  await env.http(env.fx.alphaMember1).post(`/meetings/${meeting.id}/token`, {});
});
after(async () => {
  await env.close();
});

const postTranscript = (body, secret = 'dev-runner-secret') =>
  fetch(`${env.base}/internal/meetings/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': secret },
    body: JSON.stringify(body),
  });

test('the meeting bot stores the transcript; only people who can see the meeting read it', async () => {
  assert.equal((await postTranscript({ room, segments: [{ text: 'x' }] }, 'wrong')).status, 401);
  const res = await postTranscript({
    room,
    segments: [
      { identity: env.fx.alphaManager.id, name: 'Alpha Manager', started_ms: 1000, ended_ms: 4000, text: 'We agreed to pause hiring for two weeks.' },
      { identity: env.fx.alphaMember1.id, name: 'Alpha Member One', started_ms: 5000, ended_ms: 9000, text: 'I will send the revised budget by Friday.' },
      { identity: 'agent-xyz', name: 'Someone else', started_ms: 9500, ended_ms: 9900, text: 'Hello.' },
      { identity: env.fx.alphaManager.id, name: 'Alpha Manager', started_ms: 10000, ended_ms: 10100, text: '   ' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stored, 3);
  assert.equal((await postTranscript({ room: 'orbit-00000000-0000-0000-0000-000000000000', segments: [{ text: 'x' }] })).status, 404);

  const read = await env.http(env.fx.alphaMember1).get(`/meetings/${meeting.id}/transcript`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.segments.map((s) => s.speaker_name), ['Alpha Manager', 'Alpha Member One', 'Someone else']);
  assert.equal(read.body.segments[2].membership_id, null, 'unknown identities keep only their name');
  assert.equal((await env.http(env.fx.betaMember).get(`/meetings/${meeting.id}/transcript`)).status, 404);

});

async function mintMeetingRun(membershipId, extra = {}) {
  const res = await fetch(`${env.base}/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
    body: JSON.stringify({ membership_id: membershipId, agent_id: 'x', message: 'm', channel: 'meeting', profile: 'meeting', meeting_id: meeting.id, ...extra }),
  });
  return res.json();
}

const tool = (token, action) =>
  fetch(`${env.base}/agent/tools/portfolio_os`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }).then((r) => r.json());

test('a meeting run token sees only meeting tools, bound to its one meeting', async () => {
  const { run_token: token } = await mintMeetingRun(env.fx.alphaManager.id);
  const catalog = await (await fetch(`${env.base}/agent/tools/catalog`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(catalog.profile, 'meeting');
  const actions = catalog.tools.map((t) => t.action);
  assert.ok(actions.includes('meeting_context') && actions.includes('meeting_transcript'));
  assert.ok(!catalog.tools.some((t) => t.mutating), 'the Meeting Assistant gets no write tools');

  const ctx = await tool(token, 'meeting_context');
  assert.equal(ctx.meeting.title, 'Hiring sync');
  assert.deepEqual(ctx.people.map((p) => p.name).sort(), ['Alpha Manager', 'Alpha Member One']);
  const tr = await tool(token, 'meeting_transcript');
  assert.match(tr.transcript, /\[0:01\] Alpha Manager: We agreed to pause hiring/);

  // Someone who cannot see the meeting gets nothing, even with a meeting token.
  const { run_token: outsider } = await mintMeetingRun(env.fx.betaMember.id);
  assert.equal((await tool(outsider, 'meeting_transcript')).error.code, 'not_found');

  // Meeting tools are refused on an ordinary token.
  const plain = await env.http(env.fx.alphaManager).post('/agent/tools/portfolio_os', { action: 'meeting_transcript' });
  assert.equal(plain.body.error.code, 'forbidden');

  // A meeting run without a meeting is refused.
  const bad = await fetch(`${env.base}/agent/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-secret': 'dev-runner-secret' },
    body: JSON.stringify({ membership_id: env.fx.alphaManager.id, agent_id: 'x', profile: 'meeting', channel: 'meeting' }),
  });
  assert.equal(bad.status, 400);
});

test('after the call the Meeting Assistant writes the summary; owners are matched to people', async () => {
  let seen = null;
  const stub = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    // Like services/agent-runner: mint a run token, then call the tool with it.
    const minted = await mintMeetingRun(body.membership_id);
    seen = { body, transcript: await tool(minted.run_token, 'meeting_transcript') };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        reply:
          'SUMMARY:\nThe team agreed to slow hiring and revisit the budget.\nDECISIONS:\n[-] Pause hiring for two weeks\nACTION ITEMS:\n[-] Alpha Member One | Send the revised budget | 2099-01-09\n[-] Unassigned | Book a review room | none',
        tools: [{ action: 'meeting_transcript' }],
        qlix_run_id: 'run-1',
      }),
    );
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.MEETINGS_RUNNER_URL = `http://127.0.0.1:${stub.address().port}`;
  try {
    // Ending the meeting queues the summary (once).
    const ended = await env.http(env.fx.alphaManager).post(`/meetings/${meeting.id}/end`, {});
    assert.equal(ended.body.meeting.summary_status, 'pending');
    const { rows: jobs } = await env.sql(`SELECT count(*)::int AS c FROM jobs WHERE kind = 'meeting_summarize'`);
    assert.equal(jobs[0].c, 1);

    await env.sql(`UPDATE users SET phone_e164 = '+919999000111' WHERE id = $1`, [env.fx.alphaMember1.user_id]);
    const { runMeetingSummary } = await import('../../packages/api/src/modules/meetings/assistant.js');
    await runMeetingSummary(meeting.id, env.fx.wsA.id);

    // WhatsApp digest to attendees with a number, listing their own action items.
    const { rows: wa } = await env.sql(`SELECT body FROM wa_outbox WHERE kind = 'meeting' AND to_phone = '+919999000111'`);
    assert.equal(wa.length, 1);
    assert.match(wa[0].body, /Notes from "Hiring sync"/);
    assert.match(wa[0].body, /Yours:\n• Send the revised budget \(by 2099-01-09\)/);

    assert.equal(seen.body.profile, 'meeting');
    assert.equal(seen.body.meeting_id, meeting.id);
    assert.equal(seen.body.membership_id, env.fx.alphaManager.id, 'the summary runs as the host');
    assert.match(seen.transcript.transcript, /revised budget/);

    const got = await env.http(env.fx.alphaMember1).get(`/meetings/${meeting.id}`);
    assert.equal(got.body.meeting.summary_status, 'ready');
    assert.equal(got.body.summary.summary, 'The team agreed to slow hiring and revisit the budget.');
    assert.deepEqual(got.body.summary.decisions, ['Pause hiring for two weeks']);
    const [first, second] = got.body.summary.action_items;
    assert.equal(first.owner_membership_id, env.fx.alphaMember1.id);
    assert.equal(first.due_date, '2099-01-09');
    assert.equal(second.owner_name, null);

    const { rows: notes } = await env.sql(`SELECT membership_id FROM notifications WHERE kind = 'meeting'`);
    assert.deepEqual(notes.map((n) => n.membership_id).sort(), [env.fx.alphaManager.id, env.fx.alphaMember1.id].sort());

    // Only the host / managers can ask for it again.
    assert.equal((await env.http(env.fx.alphaMember1).post(`/meetings/${meeting.id}/summary`, {})).status, 403);
    const again = await env.http(env.fx.alphaManager).post(`/meetings/${meeting.id}/summary`, {});
    assert.equal(again.body.meeting.summary_status, 'pending');
  } finally {
    delete process.env.MEETINGS_RUNNER_URL;
    await new Promise((r) => stub.close(r));
  }
});

test('when Qlix cannot answer, the meeting says why', async () => {
  const created = await env.http(env.fx.owner).post('/meetings', { instant: true, title: 'Quiet one', participant_ids: [env.fx.alphaMember1.id] });
  const m = created.body.meeting;
  await env.http(env.fx.owner).post(`/meetings/${m.id}/token`, {});
  await postTranscript({ room: `orbit-${m.id}`, segments: [{ name: 'Owner', started_ms: 0, ended_ms: 1000, text: 'Just checking.' }] });
  await env.http(env.fx.owner).post(`/meetings/${m.id}/end`, {});
  const { runMeetingSummary } = await import('../../packages/api/src/modules/meetings/assistant.js');
  await runMeetingSummary(m.id, env.fx.wsA.id); // test mode: no runner configured
  const got = await env.http(env.fx.owner).get(`/meetings/${m.id}`);
  assert.equal(got.body.meeting.summary_status, 'failed');
  assert.match(got.body.meeting.summary_error, /test mode/);
});

test('accepted action items become tasks in a project; dismissed ones are kept as dismissed', async () => {
  const { rows } = await env.sql(`SELECT id FROM units WHERE legacy_org_id = $1 LIMIT 1`, [env.fx.alpha.id]);
  const project = (await env.http(env.fx.alphaManager).post('/projects', { name: 'Hiring', unit_id: rows[0].id, status: 'active' })).body.project;
  const url = `/meetings/${meeting.id}/action-items/0`;

  assert.equal((await env.http(env.fx.alphaMember1).post(url, { decision: 'accept', project_id: project.id })).status, 403);
  assert.equal((await env.http(env.fx.alphaManager).post(url, { decision: 'accept' })).status, 400);
  assert.equal((await env.http(env.fx.alphaManager).post(`/meetings/${meeting.id}/action-items/9`, { decision: 'reject' })).status, 404);

  const ok = await env.http(env.fx.alphaManager).post(url, { decision: 'accept', project_id: project.id });
  if (ok.status !== 200) assert.fail(JSON.stringify(ok.body));
  assert.equal(ok.body.task.title, 'Send the revised budget');
  assert.equal(ok.body.task.assignee_id, env.fx.alphaMember1.id, 'defaults to the matched owner');
  assert.equal(String(ok.body.task.due_on).slice(0, 10), '2099-01-09');
  assert.equal(ok.body.action_item.status, 'accepted');
  assert.equal(ok.body.action_item.task_id, ok.body.task.id);
  assert.equal((await env.http(env.fx.alphaManager).post(url, { decision: 'accept', project_id: project.id })).status, 409);

  // It shows up in the assignee's work.
  const work = await env.http(env.fx.alphaMember1).get('/my-work');
  assert.ok(JSON.stringify(work.body).includes('Send the revised budget'));

  const rejected = await env.http(env.fx.alphaManager).post(`/meetings/${meeting.id}/action-items/1`, { decision: 'reject' });
  assert.equal(rejected.body.action_item.status, 'rejected');
  const got = await env.http(env.fx.alphaManager).get(`/meetings/${meeting.id}`);
  assert.deepEqual(got.body.summary.action_items.map((a) => a.status), ['accepted', 'rejected']);
});

test('the Assistant can answer about meetings on web and WhatsApp', async () => {
  const notes = await env.http(env.fx.alphaMember1).post('/agent/tools/portfolio_os', { action: 'meeting_notes', title: 'hiring' });
  assert.equal(notes.body.found, true, JSON.stringify(notes.body));
  assert.equal(notes.body.meeting.title, 'Hiring sync');
  assert.deepEqual(notes.body.notes.decisions, ['Pause hiring for two weeks']);
  assert.equal(notes.body.notes.action_items[0].owner, 'Alpha Member One');

  const listed = await env.http(env.fx.alphaMember1).post('/agent/tools/portfolio_os', { action: 'list_meetings' });
  assert.ok(listed.body.meetings.some((m) => m.title === 'Hiring sync' && m.notes_ready));

  // Another organisation's member can't find it.
  const other = await env.http(env.fx.betaMember).post('/agent/tools/portfolio_os', { action: 'meeting_notes', title: 'hiring' });
  assert.equal(other.body.found, false);

  const catalog = await env.http(env.fx.alphaMember1).get('/agent/tools/catalog');
  const actions = catalog.body.tools.map((t) => t.action);
  assert.ok(actions.includes('meeting_notes') && actions.includes('list_meetings'));
  assert.ok(!actions.includes('meeting_transcript'), 'transcript tools stay on meeting tokens');
});

test('rewriting the notes keeps decided action items', async () => {
  const { mergeActionItems } = await import('../../packages/api/src/modules/meetings/assistant.js');
  const prev = [
    { text: 'Send the revised budget', status: 'accepted', task_id: 't1' },
    { text: 'Book a room', status: 'rejected' },
    { text: 'Old idea', status: 'proposed' },
  ];
  const next = [{ text: 'Send the revised budget.', status: 'proposed' }, { text: 'Call the vendor', status: 'proposed' }];
  assert.deepEqual(mergeActionItems(prev, next).map((a) => `${a.text}:${a.status}`), [
    'Send the revised budget:accepted',
    'Book a room:rejected',
    'Call the vendor:proposed',
  ]);
});
