// Is the reader holding the phone on something, and is now a good moment for the photo?
// Used by the free-style camera (capture.js); no DOM here, so it is unit-tested
// (server/test/steady.test.js).
//
// 12 Nov 2026: the camera waited for a still phone. Readers' own sessions showed what
// happens with an ordinary hand: about 40% of the time the bar said "slower", photos
// came 2–6 s after stopping, and half the speed checks "lost" the picture. A trembling
// hand moves the picture fast but goes nowhere; moving along a shelf goes somewhere. So
// now:
// - holding = the picture's net drift over the last second is small, however fast it
//   trembles (only a sudden big jump, or drift, means moving on);
// - each reader's own tremor is learnt (kept on the phone), and the steady/rough limits
//   grow with it;
// - the photo is the frame where the picture and the phone's gyroscope were calmest;
// - and it is taken at the latest LATEST_MS after stopping, even if never steady.
export const STEADY = 1.5;   // px/tick (grey copy 160 px wide, tick 150 ms): held steady
export const ROUGH = 3.5;    // roughly steady
export const FAST = 7;       // "slower"
export const DRIFT = 2;      // px/tick of net movement over the last second: moving on
export const PAUSE_MS = 450; // steady this long: photo
export const ROUGH_MS = 900; // roughly steady this long: photo
export const LATEST_MS = 1600; // holding this long: the best frame so far, steady or not
const WINDOW_MS = 1000;
const CALM_GYRO = 15;        // deg/s: below this a lost picture is a glitch, not a move
const SAMPLES = 40;

// The limits for a hand that trembles `shake` px/tick (median while holding).
export function limits(shake) {
  const s = Number.isFinite(shake) ? shake : 0;
  const rough = Math.min(9, Math.max(ROUGH, 2.5 * s));
  return { steady: Math.min(4, Math.max(STEADY, 1.3 * s)), rough, fast: Math.max(FAST, rough + 3), drift: Math.max(DRIFT, Math.min(4, 0.6 * s)) };
}

// How good a frame is for the photo: sharp, with the picture and the phone calm.
export const frameScore = (sharp, v, gyro) => sharp / (1 + v) / (1 + (gyro ?? 0) / 4);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

export function createHand({ shake = null, tick = 150 } = {}) {
  let track = [], samples = [], speed = 0, edges = 0;
  return {
    get speed() { return speed; },
    // The reader's tremor: learnt from this session once there are a few samples, else
    // what an earlier session left on the phone.
    get shake() { return samples.length >= 6 ? median(samples) : shake; },
    // One look at the picture. step: the shift between this grey copy and the one before
    // ({dx, dy, edge}); dt: ms since then; gyro: the phone's mean turning speed since then
    // (deg/s, null without sensors). Returns this tick's speed v, the smoothed speed, the
    // net drift (px/tick over the last second), and lost (the picture jumped too far).
    // skip: a lost picture while the gyroscope says the phone was calm (a glitch: a
    // slow frame, exposure); and without a gyroscope one lost picture alone is a glitch.
    step(now, step, dt, gyro = null) {
      const R = step.R ?? 10;
      if (step.edge) {
        edges++;
        if ((gyro != null && gyro < CALM_GYRO) || (gyro == null && edges < 2)) return { skip: true, v: 0, speed, drift: this.drift(now), lost: false };
        track = [];
        speed = 2 * R;
        return { v: 2 * R, speed, drift: 2 * R, lost: true };
      }
      edges = 0;
      const v = Math.hypot(step.dx, step.dy) * (tick / Math.max(tick / 2, Math.min(1500, dt)));
      speed = 0.6 * v + 0.4 * speed;
      track.push({ at: now, dx: step.dx, dy: step.dy, dt });
      while (track.length && track[0].at < now - WINDOW_MS) track.shift();
      return { v, speed, drift: this.drift(now), lost: false };
    },
    // Net movement over the last second, in px per tick.
    drift(now) {
      const t = track.filter((p) => p.at >= now - WINDOW_MS);
      if (t.length < 2) return speed;
      const x = t.reduce((a, p) => a + p.dx, 0), y = t.reduce((a, p) => a + p.dy, 0);
      const span = Math.max(tick, t.reduce((a, p) => a + Math.min(1500, p.dt), 0));
      return (Math.hypot(x, y) * tick) / span;
    },
    // A speed seen while holding: learns the reader's tremor.
    learn(v) { samples = [...samples.slice(1 - SAMPLES), v]; },
    reset() { track = []; speed = 0; edges = 0; },
  };
}

// Decide, for one tick while the picture is new enough (see capture.js): `holding`
// (false = moving on: start again), and whether to take the photo now and how.
//   s: { now, arrived, steadySince, speed, drift, best, bestSharp, typical, lim }
export function decide(s) {
  const { lim } = s;
  const holding = s.speed <= lim.rough || (s.drift <= lim.drift && s.speed <= 2 * lim.fast);
  if (!holding) return { holding };
  const held = s.now - s.arrived;
  const fill = Math.max(s.steadySince ? (s.now - s.steadySince) / PAUSE_MS : 0, held / (s.speed <= lim.rough ? ROUGH_MS : LATEST_MS));
  if (!s.best) return { holding, fill };
  if (s.steadySince && s.now - s.steadySince >= PAUSE_MS) return { holding, fill, take: 'steady' };
  if (held >= ROUGH_MS && s.speed <= lim.rough && s.bestSharp >= 0.6 * s.typical) return { holding, fill, take: 'rough' };
  if (held >= LATEST_MS) return { holding, fill, take: 'shaky' };
  return { holding, fill };
}
