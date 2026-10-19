const { test } = require('node:test');
const assert = require('node:assert');
const { daySeries } = require('../lib/price-history');

const HOUR = 60 * 60 * 1000;

test('288 five-minute points ending at now → ≤96 points, first/last preserved', () => {
  const now = 1_800_000_000_000;
  const raw = [];
  for (let i = 288; i >= 0; i--) raw.push([now - i * 5 * 60 * 1000, 100 + i]);
  const out = daySeries(raw, now);
  assert.ok(out.length <= 96, `expected ≤96 points, got ${out.length}`);
  assert.strictEqual(out[0].t, raw[0][0]);
  assert.strictEqual(out[0].p, raw[0][1]);
  assert.strictEqual(out[out.length - 1].t, now);
  assert.strictEqual(out[out.length - 1].p, raw[raw.length - 1][1]);
  // Monotonic timestamps in order.
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
});

test('points older than 24h are dropped', () => {
  const now = 1_800_000_000_000;
  const raw = [
    [now - 48 * HOUR, 1],
    [now - 25 * HOUR, 2],
    [now - 23 * HOUR, 3],
    [now - HOUR, 4],
  ];
  const out = daySeries(raw, now);
  assert.strictEqual(out.length, 2);
  for (const p of out) assert.ok(p.t >= now - 24 * HOUR);
});

test('fewer points than maxPoints → mapped unchanged, same order', () => {
  const now = 1_800_000_000_000;
  const raw = [
    [now - 3 * HOUR, 10],
    [now - 2 * HOUR, 11],
    [now - HOUR, 12],
  ];
  assert.deepStrictEqual(daySeries(raw, now), [
    { t: now - 3 * HOUR, p: 10 },
    { t: now - 2 * HOUR, p: 11 },
    { t: now - HOUR, p: 12 },
  ]);
});

test('non-array or empty input → []', () => {
  assert.deepStrictEqual(daySeries(null, Date.now()), []);
  assert.deepStrictEqual(daySeries('nope', Date.now()), []);
  assert.deepStrictEqual(daySeries([], Date.now()), []);
});

test('stride not landing on last index → last point appended exactly once', () => {
  const now = 1_800_000_000_000;
  // 7 points over 24h → stride = ceil(7/3) = 3 → picks 0, 3, 6. Make the last
  // index a stride-landed case instead: 8 points, maxPoints 3 → stride 3 →
  // picks 0, 3, 6 and must append index 7 exactly once.
  const raw = [];
  for (let i = 8; i >= 0; i--) raw.push([now - i * 3 * HOUR, i]);
  const out = daySeries(raw, now, 3);
  const lastCount = out.filter((p) => p.t === raw[raw.length - 1][0]).length;
  assert.strictEqual(lastCount, 1);
  assert.strictEqual(out[out.length - 1].p, raw[raw.length - 1][1]);
});