import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv, isBlocked } from '../helpers/env.js';

/*
 * Two operations on the same organisation-day, interleaved on separate connections.
 * Whatever the order, the second one waits for the first to finish and then sees its result:
 * a number is never created or approved inside a day that has been locked.
 */
let env, fx, S, G, yesterday;
before(async () => {
  env = await createEnv();
  fx = env.fx;
  S = await env.api('domain/submissions.js');
  G = await env.api('domain/signoffs.js');
  yesterday = env.dates.addDays(env.dates.todayIn(), -1);
});
after(async () => { await env.close(); });

let n = 0;
const freshDay = () => env.dates.addDays(yesterday, -(n += 1));
const stateOf = async (id) => (await env.sql(`SELECT state FROM submissions WHERE id = $1`, [id])).rows[0]?.state;
const submissionsOn = async (day) =>
  (await env.sql(`SELECT count(*)::int AS c FROM submissions WHERE org_id = $1 AND period_date = $2`, [fx.alpha.id, day])).rows[0].c;

test('lock first, then submit: the submit waits and is refused', async () => {
  const day = freshDay();
  const locker = await env.openTransaction(fx.alphaManager);
  const writer = await env.openTransaction(fx.alphaMember1);
  assert.ok((await G.lockDay(locker.client, fx.alphaManager, 'alpha', day)).ok);

  const submit = S.recordNumber(writer.client, fx.alphaMember1, { kpi_code: fx.kpiAlpha.code, value: 5, period_date: day });
  assert.ok(await isBlocked(submit), 'submit must wait for the lock in progress');
  await locker.commit();
  assert.equal((await submit).error.code, 'locked');
  await writer.rollback();
  assert.equal(await submissionsOn(day), 0);
});

test('submit first, then lock: the lock waits, then reports the number as left unreviewed', async () => {
  const day = freshDay();
  const writer = await env.openTransaction(fx.alphaMember1);
  const locker = await env.openTransaction(fx.alphaManager);
  const rec = await S.recordNumber(writer.client, fx.alphaMember1, { kpi_code: fx.kpiAlpha.code, value: 5, period_date: day });
  assert.ok(rec.ok);

  const lock = G.lockDay(locker.client, fx.alphaManager, 'alpha', day);
  assert.ok(await isBlocked(lock), 'lock must wait for the submit in progress');
  await writer.commit();
  const locked = await lock;
  await locker.commit();
  assert.equal(locked.left_unreviewed, 1);
  assert.equal(locked.numbers_locked, 0);
  assert.equal(await stateOf(rec.submission_id), 'submitted');
});

test('lock first, then approve: the approval waits and is refused', async () => {
  const day = freshDay();
  const rec = await env.as(fx.alphaMember1, (c) => S.recordNumber(c, fx.alphaMember1, { kpi_code: fx.kpiAlpha.code, value: 5, period_date: day }));
  const locker = await env.openTransaction(fx.alphaManager);
  const reviewer = await env.openTransaction(fx.alphaLead);
  await G.lockDay(locker.client, fx.alphaManager, 'alpha', day);

  const approve = S.validateSubmission(reviewer.client, fx.alphaLead, rec.submission_id, { accept: true });
  assert.ok(await isBlocked(approve));
  await locker.commit();
  assert.equal((await approve).error.code, 'locked');
  await reviewer.rollback();
  assert.equal(await stateOf(rec.submission_id), 'submitted', 'not approved after the day closed');
});

test('approve first, then lock: the lock waits and includes the approved number', async () => {
  const day = freshDay();
  const rec = await env.as(fx.alphaMember1, (c) => S.recordNumber(c, fx.alphaMember1, { kpi_code: fx.kpiAlpha.code, value: 5, period_date: day }));
  const reviewer = await env.openTransaction(fx.alphaLead);
  const locker = await env.openTransaction(fx.alphaManager);
  assert.ok((await S.validateSubmission(reviewer.client, fx.alphaLead, rec.submission_id, { accept: true })).ok);

  const lock = G.lockDay(locker.client, fx.alphaManager, 'alpha', day);
  assert.ok(await isBlocked(lock));
  await reviewer.commit();
  const locked = await lock;
  await locker.commit();
  assert.equal(locked.numbers_locked, 1);
  assert.equal(await stateOf(rec.submission_id), 'locked');
});

test('two reviewers at once: exactly one decision is recorded', async () => {
  const day = freshDay();
  const rec = await env.as(fx.alphaMember1, (c) => S.recordNumber(c, fx.alphaMember1, { kpi_code: fx.kpiAlpha.code, value: 5, period_date: day }));
  const a = await env.openTransaction(fx.alphaLead);
  const b = await env.openTransaction(fx.alphaManager);
  assert.ok((await S.validateSubmission(a.client, fx.alphaLead, rec.submission_id, { accept: true })).ok);
  const second = S.validateSubmission(b.client, fx.alphaManager, rec.submission_id, { accept: false, reason: 'no' });
  assert.ok(await isBlocked(second));
  await a.commit();
  assert.equal((await second).error.code, 'conflict');
  await b.rollback();
  assert.equal(await stateOf(rec.submission_id), 'validated');
});

test('different organisations do not block each other', async () => {
  const day = freshDay();
  const locker = await env.openTransaction(fx.alphaManager);
  await G.lockDay(locker.client, fx.alphaManager, 'alpha', day);
  const rec = await env.as(fx.betaMember, (c) => S.recordNumber(c, fx.betaMember, { kpi_code: fx.kpiBeta.code, value: 5, period_date: day }));
  assert.ok(rec.ok, 'beta is unaffected by alpha locking its day');
  await locker.rollback();
});
