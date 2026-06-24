'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { closeDateForRound, isCgDateToday, calculatePayouts } = require('../lib/settlement');

test('closeDateForRound maps a round to the next day (CoinGecko DD-MM-YYYY)', () => {
  // A round identified by 2026-06-23 closes at 00:00 UTC on 2026-06-24.
  assert.equal(closeDateForRound('2026-06-23'), '24-06-2026');
});

test('closeDateForRound crosses a month boundary', () => {
  assert.equal(closeDateForRound('2026-06-30'), '01-07-2026');
});

test('closeDateForRound crosses a year boundary', () => {
  assert.equal(closeDateForRound('2026-12-31'), '01-01-2027');
});

test('closeDateForRound handles a leap day', () => {
  assert.equal(closeDateForRound('2028-02-29'), '01-03-2028');
});

test('isCgDateToday is true for the close date of yesterday and false otherwise', () => {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const roundDate = yesterday.toISOString().slice(0, 10);
  // Yesterday's round closes today, so its close date is today's UTC date.
  assert.equal(isCgDateToday(closeDateForRound(roundDate)), true);
  // A round from a week ago closed last week — not today.
  const weekAgo = new Date(now);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  assert.equal(isCgDateToday(closeDateForRound(weekAgo.toISOString().slice(0, 10))), false);
});

test('calculatePayouts: single guesser takes 95% of the pot', () => {
  const payouts = calculatePayouts([{ user_id: 1, distance: 5 }], 1);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].place, 1);
  assert.equal(payouts[0].prize_tokens, 0.95);
});

test('calculatePayouts: three distinct guessers split 70/20/5 of the pot', () => {
  const payouts = calculatePayouts([
    { user_id: 1, distance: 1 },
    { user_id: 2, distance: 2 },
    { user_id: 3, distance: 3 },
  ], 10);
  assert.deepEqual(payouts.map(p => p.place), [1, 2, 3]);
  assert.equal(payouts[0].prize_tokens, 7);
  assert.equal(payouts[1].prize_tokens, 2);
  assert.equal(payouts[2].prize_tokens, 0.5);
});
