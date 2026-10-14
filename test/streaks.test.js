const { test } = require('node:test');
const assert = require('node:assert');
const { computeStreaks } = require('../lib/streaks');

const d = (s) => s; // round_date strings are already 'YYYY-MM-DD'

test('no rows and no settled round → all zeros', () => {
  assert.deepStrictEqual(computeStreaks([], null), {
    daily: { current: 0, best: 0 },
    in_a_row: { current: 0, best: 0 },
  });
});

test('no rows but a settled round exists → zeros (latest day had no win)', () => {
  assert.deepStrictEqual(computeStreaks([], d('2026-10-13')), {
    daily: { current: 0, best: 0 },
    in_a_row: { current: 0, best: 0 },
  });
});

test('3 consecutive win days ending at the latest settled round → daily current 3', () => {
  const rows = [
    { round_date: d('2026-10-11'), won: true },
    { round_date: d('2026-10-12'), won: true },
    { round_date: d('2026-10-13'), won: true },
  ];
  assert.deepStrictEqual(computeStreaks(rows, d('2026-10-13')), {
    daily: { current: 3, best: 3 },
    in_a_row: { current: 3, best: 3 },
  });
});

test('a gap resets the daily current but keeps the daily best', () => {
  const rows = [
    { round_date: d('2026-10-08'), won: true },
    { round_date: d('2026-10-09'), won: true },
    { round_date: d('2026-10-12'), won: true },
    { round_date: d('2026-10-13'), won: true },
  ];
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.daily.current, 2);
  assert.strictEqual(s.daily.best, 2);
});

test('latest settled day without a win → daily current 0, best preserved', () => {
  const rows = [
    { round_date: d('2026-10-11'), won: true },
    { round_date: d('2026-10-12'), won: true },
  ];
  // The 13th settled but this player didn't win that day.
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.daily.current, 0);
  assert.strictEqual(s.daily.best, 2);
});

test('one win and one loss on the same day still counts for the daily streak', () => {
  const rows = [
    { round_date: d('2026-10-12'), won: true },
    { round_date: d('2026-10-12'), won: false },
    { round_date: d('2026-10-13'), won: false },
    { round_date: d('2026-10-13'), won: true },
  ];
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.daily.current, 2);
  assert.strictEqual(s.daily.best, 2);
});

test('in-a-row: current is the trailing run across all settled guesses', () => {
  const rows = [
    { round_date: d('2026-10-11'), won: true },
    { round_date: d('2026-10-11'), won: true },
    { round_date: d('2026-10-12'), won: false }, // loss resets the run
    { round_date: d('2026-10-13'), won: true },
  ];
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.in_a_row.current, 1);
  assert.strictEqual(s.in_a_row.best, 2);
});

test('in-a-row: trailing loss makes current 0 even with a long best', () => {
  const rows = [
    { round_date: d('2026-10-10'), won: true },
    { round_date: d('2026-10-11'), won: true },
    { round_date: d('2026-10-12'), won: true },
    { round_date: d('2026-10-13'), won: false },
  ];
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.in_a_row.current, 0);
  assert.strictEqual(s.in_a_row.best, 3);
  // Daily streak still counts the win days themselves.
  assert.strictEqual(s.daily.current, 0);
  assert.strictEqual(s.daily.best, 3);
});

test('accepts Date round_date values (as returned by pg) for rows and latest', () => {
  const rows = [
    { round_date: new Date('2026-10-12T00:00:00Z'), won: true },
    { round_date: new Date('2026-10-13T00:00:00Z'), won: true },
  ];
  const s = computeStreaks(rows, new Date('2026-10-13T00:00:00Z'));
  assert.deepStrictEqual(s, {
    daily: { current: 2, best: 2 },
    in_a_row: { current: 2, best: 2 },
  });
});

test('null/undefined won is treated as a loss', () => {
  const rows = [
    { round_date: d('2026-10-13'), won: null },
    { round_date: d('2026-10-13'), won: true },
  ];
  const s = computeStreaks(rows, d('2026-10-13'));
  assert.strictEqual(s.in_a_row.current, 1);
  assert.strictEqual(s.daily.current, 1);
});
