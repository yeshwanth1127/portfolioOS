import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dateIn, dateOrToday, isIsoDate } from '../../packages/api/src/core/dates.js';

test('business date is the IST date, not the UTC date', () => {
  // 00:30 IST on 12 Nov is 19:00 UTC on 11 Nov.
  const at = new Date('2026-11-11T19:00:00Z');
  assert.equal(dateIn('Asia/Kolkata', at), '2026-11-12');
  assert.equal(dateIn('UTC', at), '2026-11-11');
});

test('date helpers', () => {
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.ok(isIsoDate('2026-11-12'));
  assert.ok(!isIsoDate('yesterday'));
  assert.equal(dateOrToday('2026-01-05'), '2026-01-05');
  assert.match(dateOrToday('today'), /^\d{4}-\d{2}-\d{2}$/);
});
