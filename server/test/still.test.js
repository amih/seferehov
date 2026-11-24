// The free-style camera's "steady moment, then a burst" (web/src/still.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRing, push, steady, focusOk, pickBest, shakeNow, personalBest, imgSpeed, motionSample, IMG_STILL, relax, RELAX_MAX } from '../../web/src/still.js';

// Sensor samples at 60 Hz from t0 to t1, shake given by f(t) (deg/s-like units).
function sensors(ring, t0, t1, f) { for (let t = t0; t <= t1; t += 1000 / 60) push(ring, t, f(t)); }
// Picture speeds every 100 ms tick (px per 150 ms).
function image(ring, t0, t1, f) { for (let t = t0; t <= t1; t += 100) push(ring, t, f(t)); }
const wobble = (amp, t) => amp * (0.6 + 0.4 * Math.abs(Math.sin(t / 37)));

test('motionSample: turning plus weighed acceleration; nothing without sensors', () => {
  assert.equal(motionSample(null, null), null);
  assert.ok(Math.abs(motionSample({ alpha: 3, beta: 4, gamma: 0 }, { x: 0, y: 0, z: 0 }) - 5) < 1e-9);
  assert.ok(motionSample({ alpha: 0, beta: 0, gamma: 0 }, { x: 0.1, y: 0, z: 0 }) > 0.5);
});

test('imgSpeed scales a late tick to px per 150 ms', () => {
  assert.equal(imgSpeed(3, 4, 150), 5);
  assert.equal(imgSpeed(3, 4, 300), 2.5);
});

test('steady soon after the reader stops, with sensors', () => {
  const s = createRing(), img = createRing();
  sensors(s, 0, 1500, (t) => wobble(60, t)); // moving along the shelf
  image(img, 0, 1500, () => 8);
  assert.equal(steady(s, img, 1500).steady, false);
  sensors(s, 1500 + 1000 / 60, 2400, (t) => wobble(2, t)); // stopped
  image(img, 1600, 2400, () => 1);
  // The first ~150 ms after the stop still carries the movement; well within 0.5 s it is steady.
  let at = null;
  for (let now = 1600; now <= 2400; now += 50) if (steady(s, img, now).steady) { at = now; break; }
  assert.ok(at != null && at - 1500 <= 500, `steady at ${at}`);
});

test('a shaky hand: steady at its own best moments, not at its worst', () => {
  const s = createRing(), img = createRing();
  // Tremor 6–10 deg/s with calm dips to ~5 for a moment now and then.
  const f = (t) => ((Math.floor(t / 400) % 3 === 0) ? 5 : 8 + 2 * Math.sin(t / 20));
  sensors(s, 0, 3000, f);
  image(img, 0, 3000, () => 2);
  const best = personalBest(s, 3000);
  assert.ok(best >= 4 && best <= 7, `best ${best}`);
  const calm = [], rough = [];
  for (let now = 500; now <= 3000; now += 50) {
    const r = steady(s, img, now);
    (f(now) <= 5 && f(now - 150) <= 5 ? calm : f(now - 150) > 6 ? rough : []).push(r.steady);
  }
  assert.ok(calm.some(Boolean), 'steady at some calm moment');
  assert.ok(rough.filter(Boolean).length / rough.length < 0.1, 'not when trembling');
});

test('never steady during fast motion, even when the hand is never calmer', () => {
  const s = createRing(), img = createRing();
  sensors(s, 0, 3000, () => 80); // turning all the time: the reader's "best" is 80
  image(img, 0, 3000, () => 9);
  for (let now = 200; now <= 3000; now += 100) assert.equal(steady(s, img, now).steady, false);
  // Calm sensors but the picture moves (sliding along a shelf): not steady either.
  const s2 = createRing(), img2 = createRing();
  sensors(s2, 0, 3000, () => 1);
  image(img2, 0, 3000, () => IMG_STILL + 2);
  for (let now = 200; now <= 3000; now += 100) assert.equal(steady(s2, img2, now).steady, false);
});

test('no sensors: the picture alone, by the same rule', () => {
  const s = createRing(), img = createRing();
  image(img, 0, 1500, () => 7);
  assert.equal(steady(s, img, 1500).steady, false);
  image(img, 1600, 2500, () => 0.5);
  const r = steady(s, img, 2500);
  assert.equal(r.by, 'image');
  assert.equal(r.steady, true);
  // A trembling hand that never gets below 2 px: steady at its best, but never above IMG_STILL.
  const img2 = createRing();
  image(img2, 0, 3000, (t) => (Math.floor(t / 100) % 4 === 0 ? 2 : 2.8));
  assert.equal(steady(s, img2, 2800).steady, true);
  const img3 = createRing();
  image(img3, 0, 3000, () => IMG_STILL + 1);
  assert.equal(steady(s, img3, 3000).steady, false);
});

test('stale sensors count as none', () => {
  const s = createRing(), img = createRing();
  sensors(s, 0, 500, () => 100);
  image(img, 0, 3000, () => 0.5);
  assert.equal(steady(s, img, 3000).by, 'image');
  assert.ok(shakeNow(s, 500) > 50);
});

test('focus: frames still focusing are refused', () => {
  const f = createRing();
  push(f, 0, 100); push(f, 100, 300); push(f, 200, 120);
  assert.equal(focusOk(f, 200, 120), false);
  assert.equal(focusOk(f, 200, 250), true);
  assert.equal(focusOk(createRing(), 0, 999), false, 'not known yet');
});

test('pickBest keeps the best and a second that shows a little more or is clearly sharp', () => {
  const b = [
    { id: 1, score: 50, sharp: 100, x: 0, y: 0 },
    { id: 2, score: 60, sharp: 110, x: 1, y: 0 },
    { id: 3, score: 55, sharp: 80, x: 1, y: 1 },  // too close to 2 and not as sharp
    { id: 4, score: 40, sharp: 70, x: 5, y: 0 },  // further along
  ];
  // 1 is 1 px from 2 and sharp 100 ≥ 0.9 × 110: clearly sharp, so it is the second.
  assert.deepEqual(pickBest(b, 2).map((x) => x.id), [2, 1]);
  // Without a sharp one, the one further along.
  assert.deepEqual(pickBest(b.filter((x) => x.id !== 1), 2).map((x) => x.id), [2, 4]);
  // Nothing apart and nothing sharp: only one.
  assert.deepEqual(pickBest([{ id: 1, score: 9, sharp: 100, x: 0, y: 0 }, { id: 2, score: 5, sharp: 50, x: 1, y: 0 }], 2).map((x) => x.id), [1]);
  assert.deepEqual(pickBest([], 2), []);
  assert.equal(pickBest(b, 1).length, 1);
});

// Ami, 24 Nov: the longer the phone is held at a shelf, the less steady it has to be.
test('relax: 1 at arrival, grows with time held, capped', () => {
  assert.equal(relax(0), 1);
  assert.equal(relax(1000), 2);
  assert.equal(relax(60000), RELAX_MAX);
});
test('steady: a shake too big at arrival is accepted after holding a while (image only)', () => {
  const s = createRing(), img = createRing();
  for (let t = 0; t <= 3000; t += 100) push(img, t, 2 * IMG_STILL);
  assert.equal(steady(s, img, 3000, 0).steady, false);
  assert.equal(steady(s, img, 3000, 1500).steady, true);
});
test('focusOk: a slow phone (looks 3 s apart) still gets a focus verdict from its last 2 looks', () => {
  const f = createRing(10000);
  push(f, 0, 100); push(f, 3000, 95);
  assert.equal(focusOk(f, 3000, 95), true);
  assert.equal(focusOk(f, 3000, 40), false);
});
