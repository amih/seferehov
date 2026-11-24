// When to take the photo, for the free-style camera (capture.js): "a steady moment, then
// a burst". No DOM here, so it is unit-tested (server/test/still.test.js).
//
// 24 Nov 2026. The camera before this (steady.js, kept behind
// localStorage['seferehov.camAlgo'] = 'v0') waited through timed tiers (450 / 900 /
// 1,600 ms) judged from the picture alone. Readers' sessions (14–23 Nov) showed 4.4 s at
// the median from a new shelf to the photo, and 6–9 s per shelf. Now:
// - the phone's motion sensors say when the hand is as steady as it gets: "shake now"
//   (the last 150 ms) close to the reader's own best of the last 3 s (each hand differs);
// - the picture only confirms (no shift of more than IMG_STILL);
// - the picture must be in focus (sharpness close to the best of the last 1.5 s);
// - then the photo at once, and a few more silently: the best 2 are kept (pickBest).

export const RING_MS = 3000;     // the sensor samples kept
export const NOW_MS = 150;       // "shake now": root mean square over this long
export const BEST_PCT = 0.2;     // the reader's best: this percentile of shake over RING_MS
export const BEST_SLACK = 1.3;   // steady = shake now ≤ best × this …
export const SHAKE_FLOOR = 3;    // … or ≤ this (deg/s-like units: a phone lying on a table ~0.5–1)
export const SHAKE_CEIL = 30;    // never steady above this, whatever the reader's best (walking, turning)
export const ACC_W = 10;         // m/s² of acceleration (gravity out) weighed as this many deg/s of turning
export const RISE = 1.1;         // "rising": shake now > this × shake 100 ms ago (+ a little)
// The picture's own shift between ticks, in px of the 160-px-wide grey copy per 150 ms
// (ticks may come late: the shift is scaled to 150 ms). 1 px at 160 px ≈ 13–14 px at 4K.
export const IMG_STILL = 3;
export const IMG_FLOOR = 1;      // without sensors: steady = shift ≤ max(best × BEST_SLACK, this), capped at IMG_STILL
export const IMG_PER_MS = 150;
export const SENSOR_STALE_MS = 500; // no sample for this long: no sensors (iOS before permission, desktop)
export const FOCUS_MS = 1500;    // focus is judged against the best of this long …
export const FOCUS_SHARE = 0.7;  // … needing at least this share of it
export const SHIFT_APART = 3;    // the second kept photo: this far from the first (px of the grey copy) …
export const CLEAR_SHARP = 0.9;  // … or at least this share of the first's sharpness

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// A ring of samples { t, v }; each also carries `rms`: v's root mean square over the
// NOW_MS before it (so the percentile is over "shake now" values, not single readings).
export function createRing(keepMs = RING_MS) { return { keepMs, s: [] }; }
export function push(ring, t, v) {
  const s = ring.s;
  while (s.length && s[0].t < t - ring.keepMs) s.shift();
  let sq = v * v, n = 1;
  for (let i = s.length - 1; i >= 0 && s[i].t > t - NOW_MS; i--) { sq += s[i].v * s[i].v; n++; }
  s.push({ t, v, rms: Math.sqrt(sq / n) });
}
const lastAt = (ring, t) => { for (let i = ring.s.length - 1; i >= 0; i--) if (ring.s[i].t <= t) return ring.s[i]; return null; };

// One devicemotion event as one number: turning (deg/s) plus acceleration without gravity.
export function motionSample(rotationRate, acceleration) {
  const r = rotationRate?.alpha != null ? Math.hypot(rotationRate.alpha, rotationRate.beta ?? 0, rotationRate.gamma ?? 0) : null;
  const a = acceleration?.x != null ? Math.hypot(acceleration.x, acceleration.y ?? 0, acceleration.z ?? 0) : null;
  if (r == null && a == null) return null;
  return (r ?? 0) + ACC_W * (a ?? 0);
}

export const hasSensors = (ring, now) => !!ring.s.length && now - ring.s.at(-1).t <= SENSOR_STALE_MS;
export const shakeNow = (ring, now) => lastAt(ring, now)?.rms ?? null;
export function personalBest(ring, now) { return pct(ring.s.filter((x) => x.t > now - RING_MS && x.t <= now).map((x) => x.rms), BEST_PCT); }
function rising(ring, now) {
  const a = lastAt(ring, now), b = lastAt(ring, now - 100);
  return !!(a && b && b !== a && a.rms > RISE * b.rms + 0.05);
}

// The picture's shift per tick, scaled to px per IMG_PER_MS.
export const imgSpeed = (dx, dy, dt) => Math.hypot(dx, dy) * (IMG_PER_MS / Math.max(IMG_PER_MS / 3, Math.min(1500, dt || IMG_PER_MS)));

// Is the hand steady now? sensors: the motion ring; img: the ring of picture speeds
// (imgSpeed, one per tick). Returns { steady, by: 'sensors' | 'image', shake, best }.
// shake is in the sensors' units with sensors, else px per 150 ms.
export function steady(sensors, img, now) {
  const imgNow = lastAt(img, now)?.v ?? null;
  if (imgNow == null) return { steady: false, by: null, shake: null, best: null };
  if (hasSensors(sensors, now)) {
    const shake = shakeNow(sensors, now), best = personalBest(sensors, now);
    const ok = shake <= SHAKE_CEIL && shake <= Math.max(best * BEST_SLACK, SHAKE_FLOOR) && !rising(sensors, now) && imgNow <= IMG_STILL;
    return { steady: ok, by: 'sensors', shake, best };
  }
  // No sensors: the picture's speed alone, the same rule (the last tick, against the
  // reader's best of the last 3 s), never above IMG_STILL.
  const best = pct(img.s.filter((x) => x.t > now - RING_MS && x.t <= now).map((x) => x.v), BEST_PCT);
  const prev = lastAt(img, now - 100);
  const up = prev && prev !== lastAt(img, now) && imgNow > RISE * prev.v + 0.5;
  const ok = imgNow <= Math.min(IMG_STILL, Math.max(best * BEST_SLACK, IMG_FLOOR)) && !up;
  return { steady: ok, by: 'image', shake: imgNow, best };
}

// In focus: sharpness at least FOCUS_SHARE of the best of the last FOCUS_MS (focus ring:
// samples { t, v = sharpness }). With fewer than 2 looks it is not known yet: no.
export function focusOk(focus, now, sharp) {
  const seen = focus.s.filter((x) => x.t > now - FOCUS_MS && x.t <= now);
  if (seen.length < 2) return false;
  return sharp >= FOCUS_SHARE * Math.max(...seen.map((x) => x.v));
}

// How good a frame is for the photo.
export const frameScore = (sharp, shake) => sharp / (1 + Math.max(0, shake ?? 0));

// The best `k` (1 or 2) of a burst: [{ score, sharp, x, y, … }] where x, y is where the
// picture had moved since the burst's first frame (px of the grey copy). The second must
// show a little more (SHIFT_APART away from the first) or be clearly sharp, so the server
// gets two useful views. Returns the kept items, best first.
export function pickBest(burst, k = 2) {
  const s = [...burst].sort((a, b) => b.score - a.score);
  if (!s.length) return [];
  const first = s[0], out = [first];
  if (k < 2) return out;
  const second = s.slice(1).find((c) => Math.hypot(c.x - first.x, c.y - first.y) >= SHIFT_APART || c.sharp >= CLEAR_SHARP * first.sharp);
  if (second) out.push(second);
  return out;
}
