// The free-style camera's "is the reader holding still enough?" (web/src/steady.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHand, decide, limits, LATEST_MS, ROUGH_MS } from '../../web/src/steady.js';

// Feed a hand ticks every 150 ms; returns the last step's result.
function run(hand, shifts, gyro = null, t0 = 0) {
  let r, now = t0;
  for (const [dx, dy, edge] of shifts) { now += 150; r = hand.step(now, { dx, dy, edge: !!edge, R: 10 }, 150, gyro); }
  return { ...r, now };
}

test('a trembling hand moves fast but goes nowhere: still holding', () => {
  const hand = createHand();
  const shake = Array.from({ length: 12 }, (_, i) => (i % 2 ? [-5, 2] : [5, -2])); // ±5 px each tick
  const r = run(hand, shake);
  const lim = limits(null);
  assert.ok(r.speed > lim.rough, 'too fast for "roughly steady"');
  assert.ok(r.drift < lim.drift, 'but no drift');
  assert.equal(decide({ now: r.now, arrived: r.now - 500, steadySince: 0, speed: r.speed, drift: r.drift, best: {}, bestSharp: 100, typical: 100, lim }).holding, true);
});

test('moving along a shelf drifts: not holding', () => {
  const hand = createHand();
  const r = run(hand, Array.from({ length: 10 }, () => [6, 0]));
  const lim = limits(null);
  assert.ok(r.drift > lim.drift);
  assert.equal(decide({ now: r.now, arrived: r.now - 500, steadySince: 0, speed: r.speed, drift: r.drift, best: null, bestSharp: 0, typical: 8, lim }).holding, false);
});

test('a shaky hand still gets its photo by LATEST_MS, a steadier one sooner', () => {
  const lim = limits(null);
  const base = { steadySince: 0, best: {}, bestSharp: 50, typical: 100, lim, drift: 0.5 };
  assert.equal(decide({ ...base, now: LATEST_MS - 10, arrived: 0, speed: 6 }).take, undefined);
  assert.equal(decide({ ...base, now: LATEST_MS, arrived: 0, speed: 6 }).take, 'shaky');
  assert.equal(decide({ ...base, now: ROUGH_MS, arrived: 0, speed: 3, bestSharp: 100 }).take, 'rough');
  assert.equal(decide({ ...base, now: 1000, arrived: 0, steadySince: 500, speed: 1 }).take, 'steady');
});

test('the limits grow with the reader\'s tremor, within bounds', () => {
  assert.deepEqual(limits(null), limits(0));
  assert.ok(limits(3).rough > limits(0).rough);
  assert.ok(limits(100).rough <= 9 && limits(100).steady <= 4 && limits(100).drift <= 4);
});

test('the hand learns its tremor', () => {
  const hand = createHand({ shake: 2 });
  assert.equal(hand.shake, 2);
  for (const v of [3, 4, 3, 5, 4, 3]) hand.learn(v);
  assert.equal(hand.shake, 4);
});

test('a lost picture with a calm gyroscope, or a single one without, is a glitch', () => {
  assert.equal(createHand().step(150, { dx: 10, dy: 0, edge: true, R: 10 }, 150, 5).skip, true);
  assert.equal(createHand().step(150, { dx: 10, dy: 0, edge: true, R: 10 }, 150, 80).lost, true);
  const h = createHand();
  assert.equal(h.step(150, { dx: 10, dy: 0, edge: true, R: 10 }, 150, null).skip, true);
  assert.equal(h.step(300, { dx: 10, dy: 0, edge: true, R: 10 }, 150, null).lost, true);
});

test('a slow phone (ticks 1.4 s apart) does not count its drift as speed ×3', () => {
  const h = createHand();
  const r = h.step(1400, { dx: 6, dy: 0, edge: false, R: 10 }, 1400, null);
  assert.ok(r.v < 1, `v=${r.v}`);
});
