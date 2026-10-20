const { test } = require('node:test');
const assert = require('node:assert');
const { weekStartFor, weekEndFor, isCompletedWeek, weekLabel, chipLabel } = require('../lib/weeks');

// Monday computation

test('a Monday maps to itself', () => {
  assert.strictEqual(weekStartFor('2026-10-12'), '2026-10-12'); // 2026-10-12 is a Monday
});

test('a mid-week day maps back to that week\'s Monday', () => {
  assert.strictEqual(weekStartFor('2026-10-14'), '2026-10-12'); // Wednesday
  assert.strictEqual(weekStartFor('2026-10-18'), '2026-10-12'); // Sunday
});

test('a Sunday belongs to the week that started the previous Monday', () => {
  assert.strictEqual(weekStartFor('2026-10-18'), '2026-10-12');
});

test('Monday computation crosses a year boundary', () => {
  // 2027-01-01 is a Friday → its week's Monday is 2026-12-28.
  assert.strictEqual(weekStartFor('2027-01-01'), '2026-12-28');
  assert.strictEqual(weekStartFor('2027-01-04'), '2027-01-04'); // that Monday
});

test('accepts Date values (as returned by pg)', () => {
  assert.strictEqual(weekStartFor(new Date('2026-10-14T15:30:00Z')), '2026-10-12');
});

// Week end

test('weekEndFor returns the week\'s Sunday', () => {
  assert.strictEqual(weekEndFor('2026-10-12'), '2026-10-18');
  assert.strictEqual(weekEndFor('2026-12-28'), '2027-01-03'); // year boundary
});

// Completed vs running

test('a week is completed once now reaches the next Monday 00:00 UTC', () => {
  assert.strictEqual(isCompletedWeek('2026-10-12', new Date('2026-10-19T00:00:00Z')), true);
});

test('a week is still running through its own Sunday', () => {
  assert.strictEqual(isCompletedWeek('2026-10-12', new Date('2026-10-18T23:59:59Z')), false);
});

test('a future week is not completed', () => {
  assert.strictEqual(isCompletedWeek('2026-10-19', new Date('2026-10-14T12:00:00Z')), false);
});

// Labels

test('weekLabel formats in UTC with month and day', () => {
  assert.strictEqual(weekLabel('2026-10-12'), 'Week of Oct 12');
  assert.strictEqual(weekLabel('2026-12-28'), 'Week of Dec 28');
});

test('chipLabel formats a short UTC date', () => {
  assert.strictEqual(chipLabel('2026-10-12'), 'Oct 12');
  assert.strictEqual(chipLabel('2026-12-28'), 'Dec 28');
});
