import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env, fx, S, G, today, yesterday;
before(async () => {
  env = await createEnv();
  fx = env.fx;
  S = await env.api('domain/submissions.js');
  G = await env.api('domain/signoffs.js');
  today = env.dates.todayIn();
  yesterday = env.dates.addDays(today, -1);
});
after(async () => { await env.close(); });

let dayOffset = 0;
/** Every test works on its own past day so they cannot affect each other. */
const freshDay = () => env.dates.addDays(yesterday, -(dayOffset += 1));

const record = (who, kpi, value, period_date, extra = {}) =>
  env.as(who, (c) => S.recordNumber(c, who, { kpi_code: kpi.code, value, period_date, channel: 'web', ...extra }));
const review = (who, id, accept, reason) => env.as(who, (c) => S.validateSubmission(c, who, id, { accept, reason }));
const amend = (who, id, value, reason) => env.as(who, (c) => S.amendNumber(c, who, id, value, reason));
const withdraw = (who, id) => env.as(who, (c) => S.withdrawSubmission(c, who, id));
const lock = (who, slug, day) => env.as(who, (c) => G.lockDay(c, who, slug, day));
const reopen = (who, slug, day, reason) => env.as(who, (c) => G.reopenDay(c, who, slug, day, reason));
const row = async (id) => (await env.sql(`SELECT * FROM submissions WHERE id = $1`, [id])).rows[0];
const scoreFor = async (kpiId, day) =>
  (await env.sql(`SELECT value, rag FROM scores WHERE kpi_id = $1 AND period_date = $2 AND how_often = 'Every day'`, [kpiId, day])).rows[0];

test('record → approve → lock: the number is scored', async () => {
  const day = freshDay();
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 12, day);
  assert.equal(rec.state, 'submitted');
  assert.equal((await review(fx.alphaLead, rec.submission_id, true)).state, 'validated');
  const locked = await lock(fx.alphaManager, 'alpha', day);
  assert.equal(locked.numbers_locked, 1);
  assert.equal((await row(rec.submission_id)).state, 'locked');
  assert.deepEqual(await scoreFor(fx.kpiAlpha.id, day), { value: '12', rag: 'green' });
});

test('recording needs a real number and a valid, non-future date', async () => {
  assert.equal((await record(fx.alphaMember1, fx.kpiAlpha, 'lots', freshDay())).error.code, 'invalid');
  assert.equal((await record(fx.alphaMember1, fx.kpiAlpha, 5, 'tomorrow')).error.code, 'invalid');
  assert.equal((await record(fx.alphaMember1, fx.kpiAlpha, 5, env.dates.addDays(today, 1))).error.code, 'invalid');
});

test('a member records only the KPIs they own; nobody records in another organisation', async () => {
  assert.equal((await record(fx.alphaMember2, fx.kpiAlpha, 5, freshDay())).error.code, 'forbidden');
  // Another organisation's KPI is invisible (RLS): not found, and never matched to a look-alike.
  assert.equal((await record(fx.betaManager, fx.kpiAlpha, 5, freshDay())).error.code, 'not_found');
  assert.equal((await record(fx.betaMember, fx.kpiAlpha, 5, freshDay())).error.code, 'not_found');
});

test('approval: organisation scope', async () => {
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 7, freshDay());
  // Other organisations cannot see the submission at all (row-level security).
  assert.equal((await review(fx.betaManager, rec.submission_id, true)).error.code, 'not_found');
  assert.equal((await review(fx.betaLead, rec.submission_id, true)).error.code, 'not_found');
  assert.equal((await row(rec.submission_id)).state, 'submitted');
  // the owner can review anywhere
  assert.equal((await review(fx.owner, rec.submission_id, true)).state, 'validated');
});

test('approval: reviewer authority', async () => {
  const day = freshDay();
  const mine = await record(fx.alphaMember1, fx.kpiAlpha, 7, day);
  // members cannot review
  assert.equal((await review(fx.alphaMember2, mine.submission_id, true)).error.code, 'forbidden');
  // a team lead reviews only their own team: member2 reports to the manager, not the lead
  const other = await record(fx.alphaMember2, fx.kpiAlphaOther, 3, day);
  assert.equal((await review(fx.alphaLead, other.submission_id, true)).error.code, 'forbidden');
  assert.equal((await review(fx.alphaLead, mine.submission_id, true)).state, 'validated');
  assert.equal((await review(fx.alphaManager, other.submission_id, true)).state, 'validated');
});

test('approval: no self-review below manager; managers and the owner have nobody above them', async () => {
  const day = freshDay();
  const byLead = await record(fx.alphaLead, fx.kpiAlpha, 4, day);
  assert.equal((await review(fx.alphaLead, byLead.submission_id, true)).error.code, 'forbidden');
  assert.equal((await review(fx.alphaManager, byLead.submission_id, true)).state, 'validated');
  const byManager = await record(fx.alphaManager, fx.kpiAlpha, 9, day);
  assert.equal((await review(fx.alphaManager, byManager.submission_id, true)).state, 'validated');
});

test('approval: only a submitted number can be reviewed; rejecting needs a reason', async () => {
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 7, freshDay());
  assert.equal((await review(fx.alphaLead, rec.submission_id, false, '  ')).error.code, 'invalid');
  assert.equal((await review(fx.alphaLead, rec.submission_id, true)).state, 'validated');
  assert.equal((await review(fx.alphaLead, rec.submission_id, true)).error.code, 'conflict');
  assert.equal((await review(fx.alphaManager, rec.submission_id, false, 'late')).error.code, 'conflict');
});

test('correcting an approved number sends it back for review, keeps history, and is not scored', async () => {
  const day = freshDay();
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 12, day);
  await review(fx.alphaLead, rec.submission_id, true);

  const fixed = await amend(fx.alphaMember1, rec.submission_id, 2, 'typo');
  assert.equal(fixed.state, 'submitted');
  const after = await row(rec.submission_id);
  assert.equal(after.state, 'submitted');
  assert.equal(after.validated_by, null);
  assert.equal(after.value, '2');

  const history = await env.as(fx.alphaManager, (c) => S.listAmendments(c, fx.alphaManager, rec.submission_id));
  assert.equal(history.amendments.length, 1);
  assert.equal(history.amendments[0].old_value, '12');
  assert.equal(history.amendments[0].new_value, '2');
  assert.equal(history.amendments[0].reason, 'typo');

  // Locking now must NOT score the unreviewed correction.
  const locked = await lock(fx.alphaManager, 'alpha', day);
  assert.equal(locked.numbers_locked, 0);
  assert.equal(locked.left_unreviewed, 1);
  const score = await scoreFor(fx.kpiAlpha.id, day);
  assert.equal(score.value, null);
  assert.equal(score.rag, 'unscored');
});

test('a rejected number can be re-entered and reviewed again', async () => {
  const day = freshDay();
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 50, day);
  assert.equal((await review(fx.alphaLead, rec.submission_id, false, 'too high')).state, 'rejected');
  const again = await record(fx.alphaMember1, fx.kpiAlpha, 5, day, { reason: 'fixed' });
  assert.equal(again.submission_id, rec.submission_id);
  assert.ok(again.corrected);
  const r = await row(rec.submission_id);
  assert.equal(r.state, 'submitted');
  assert.equal(r.reject_reason, null);
  assert.equal((await review(fx.alphaLead, rec.submission_id, true)).state, 'validated');
});

test('who can correct or withdraw', async () => {
  const day = freshDay();
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 7, day);
  assert.equal((await amend(fx.alphaMember2, rec.submission_id, 1, 'x')).error.code, 'forbidden');
  assert.equal((await amend(fx.betaManager, rec.submission_id, 1, 'x')).error.code, 'not_found');
  assert.equal((await withdraw(fx.alphaMember2, rec.submission_id)).error.code, 'forbidden');
  assert.ok((await amend(fx.alphaMember1, rec.submission_id, 7, 'same')).unchanged);
  // an approved number is corrected, not withdrawn
  await review(fx.alphaLead, rec.submission_id, true);
  assert.equal((await withdraw(fx.alphaMember1, rec.submission_id)).error.code, 'conflict');
  // back to submitted via a correction → can be withdrawn, history goes with it
  await amend(fx.alphaMember1, rec.submission_id, 8, 'recount');
  assert.ok((await withdraw(fx.alphaMember1, rec.submission_id)).ok);
  assert.equal(await row(rec.submission_id), undefined);
});

test('nothing changes inside a locked day', async () => {
  const day = freshDay();
  const approved = await record(fx.alphaMember1, fx.kpiAlpha, 12, day);
  await review(fx.alphaLead, approved.submission_id, true);
  const pending = await record(fx.alphaMember2, fx.kpiAlphaOther, 3, day);
  await lock(fx.alphaManager, 'alpha', day);

  assert.equal((await record(fx.alphaMember1, fx.kpiAlpha, 99, day)).error.code, 'locked');
  assert.equal((await record(fx.alphaManager, fx.kpiAlpha, 99, day)).error.code, 'locked');
  assert.equal((await amend(fx.alphaManager, approved.submission_id, 99, 'x')).error.code, 'locked');
  assert.equal((await withdraw(fx.alphaManager, pending.submission_id)).error.code, 'locked');
  assert.equal((await review(fx.alphaManager, pending.submission_id, true)).error.code, 'locked');
  assert.equal((await row(approved.submission_id)).value, '12');
  assert.equal((await row(approved.submission_id)).state, 'locked');
  assert.ok((await lock(fx.alphaManager, 'alpha', day)).already_locked);
});

test('who can lock and reopen', async () => {
  const day = freshDay();
  assert.equal((await lock(fx.alphaLead, 'alpha', day)).error.code, 'forbidden');
  assert.equal((await lock(fx.betaManager, 'alpha', day)).error.code, 'forbidden');
  assert.equal((await lock(fx.owner, 'alpha', env.dates.addDays(today, 1))).error.code, 'invalid');
  assert.ok((await lock(fx.owner, 'alpha', day)).ok);
  assert.equal((await reopen(fx.alphaLead, 'alpha', day, 'x')).error.code, 'forbidden');
  assert.equal((await reopen(fx.betaManager, 'alpha', day, 'x')).error.code, 'forbidden');
  assert.equal((await reopen(fx.alphaManager, 'alpha', day, '')).error.code, 'invalid');
  assert.equal((await reopen(fx.alphaManager, 'alpha', freshDay(), 'never locked')).error.code, 'invalid');
});

test('reopen → correct → approve → lock again, with an audit trail', async () => {
  const day = freshDay();
  const rec = await record(fx.alphaMember1, fx.kpiAlpha, 12, day);
  await review(fx.alphaLead, rec.submission_id, true);
  await lock(fx.alphaManager, 'alpha', day);

  const opened = await reopen(fx.alphaManager, 'alpha', day, 'wrong count from site B');
  assert.equal(opened.numbers_reopened, 1);
  assert.equal((await row(rec.submission_id)).state, 'validated');
  assert.equal(await scoreFor(fx.kpiAlpha.id, day), undefined, 'a reopened day is not scored');
  const period = (await env.sql(`SELECT * FROM org_periods WHERE org_id = $1 AND period_date = $2`, [fx.alpha.id, day])).rows[0];
  assert.equal(period.status, 'open');
  assert.equal(period.reopened_by, fx.alphaManager.id);
  assert.equal(period.reopen_reason, 'wrong count from site B');
  assert.equal((await env.sql(`SELECT count(*)::int AS c FROM signoffs WHERE org_id = $1 AND period_date = $2`, [fx.alpha.id, day])).rows[0].c, 0);

  await amend(fx.alphaMember1, rec.submission_id, 6, 'site B recount');
  await review(fx.alphaLead, rec.submission_id, true);
  await lock(fx.alphaManager, 'alpha', day);
  assert.deepEqual(await scoreFor(fx.kpiAlpha.id, day), { value: '6', rag: 'red' });
});

test('HTTP: status codes for the same rules', async () => {
  const day = freshDay();
  const member = env.http(fx.alphaMember1);
  const created = await member.post('/submissions', { kpi_code: fx.kpiAlpha.code, value: 11, period_date: day });
  assert.equal(created.status, 200);
  const id = created.body.submission_id;

  assert.equal((await env.http(fx.betaManager).post(`/submissions/${id}/validate`, { accept: true })).status, 404);
  assert.equal((await env.http(fx.alphaLead).post(`/submissions/${id}/validate`, { accept: true })).status, 200);
  assert.equal((await env.http(fx.alphaLead).post(`/submissions/${id}/validate`, { accept: true })).status, 409);
  assert.equal((await env.http(fx.alphaManager).post('/orgs/alpha/signoff', { period_date: day })).status, 200);
  assert.equal((await member.patch(`/submissions/${id}`, { value: 1, reason: 'x' })).status, 423);
  assert.equal((await member.post('/submissions', { kpi_code: fx.kpiAlpha.code, value: 1, period_date: day })).status, 423);
  assert.equal((await env.http(fx.alphaLead).post('/orgs/alpha/reopen', { period_date: day, reason: 'x' })).status, 403);
  assert.equal((await env.http(fx.alphaManager).post('/orgs/alpha/reopen', { period_date: day, reason: 'fix' })).status, 200);
  assert.equal((await member.patch(`/submissions/${id}`, { value: 9, reason: 'fix' })).status, 200);
  assert.equal((await member.get(`/submissions/${id}/amendments`)).body.amendments.length, 1);
  assert.equal((await member.get('/submissions/not-a-uuid/amendments')).status, 404);
  assert.equal((await fetch(`${env.base}/orgs`)).status, 401);
});

test('agent tool endpoint follows the same rules', async () => {
  const day = freshDay();
  const tool = (who, body) => env.http(who).post('/agent/tools/portfolio_os', body);
  const rec = await tool(fx.alphaMember1, { action: 'record_number', kpi_code: fx.kpiAlpha.code, value: 10, date: day });
  assert.equal(rec.body.period_date, day);
  const id = rec.body.submission_id;
  assert.equal((await tool(fx.betaManager, { action: 'validate_submission', submission_id: id, accept: true })).body.error.code, 'not_found');
  assert.ok((await tool(fx.alphaLead, { action: 'validate_submission', submission_id: id, accept: true })).body.ok);
  assert.equal((await tool(fx.alphaLead, { action: 'lock_day', org_slug: 'alpha', date: day })).body.error.code, 'forbidden');
  assert.ok((await tool(fx.alphaManager, { action: 'lock_day', org_slug: 'alpha', date: day })).body.ok);
  assert.equal((await tool(fx.alphaMember1, { action: 'amend_number', submission_id: id, value: 1 })).body.error.code, 'locked');
  assert.ok((await tool(fx.alphaManager, { action: 'reopen_day', org_slug: 'alpha', date: day, reason: 'recount' })).body.ok);
  const catalog = await env.http(fx.alphaLead).get('/agent/tools/catalog');
  const actions = catalog.body.tools.map((t) => t.action);
  assert.ok(!actions.includes('reopen_day') && !actions.includes('lock_day'), 'team lead is not offered lock/reopen');
  assert.ok((await env.http(fx.alphaManager).get('/agent/tools/catalog')).body.tools.some((t) => t.action === 'reopen_day'));
});
