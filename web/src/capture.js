import { esc, shrinkImage } from './ui.js';
import { startHints, rememberSession } from './hints.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { cameraLog } from './camlog.js';
import { enqueue, kick, onItem, unsentItems } from './queue.js';
import { detectFrame } from './scanner.js';
import { align, cost, mean, R } from './motion.js';
import { createHand, decide, frameScore, limits, STEADY, ROUGH, PAUSE_MS } from './steady.js';
import * as still from './still.js';
import { encodeJpeg, encodeBitmap } from './encode.js';

// One camera for every book photo, free style: shelves (spines), front covers and back
// covers, in any order. The phone only takes the photos; the server works out what each
// one shows and which front goes with which back (server/src/pairing.js). On 3 Nov 2026
// the phone's own guess (turned over = same book, moved sideways = next book) split three
// books into six: a book turned over on a shelf moves in the picture just as the phone
// moving on does.
//
// A photo is taken when the picture has changed since the last photo (moved along the
// shelf, or a new cover: a book turned over, the next book) and the phone is then steady
// and the picture in focus (burst-v1, below; the older camera, 'v0', waited PAUSE_MS /
// ROUGH_MS / LATEST_MS: steady.js); full size. Each photo is saved on the phone and sent by itself
// (queue.js), with its number in the session, the time, the barcode the camera saw just
// before (if any), and how the phone moved since the last photo (motion sensors, picture
// travel): logged for the server, to learn from. When the camera closes (✕, Done, screen
// off, another app, leaving the screen) the server is told how many photos were taken, so
// it can sort the session as soon as they are all there. request() gives the address
// fields (library code or My books, kind, position).
const TICK_MS = 150;
const W = 160;            // width of the grey copy; speeds are in its pixels per tick
// 6 Nov 2026, made more lax: a photo at a shorter, rougher pause and after less travel (each
// spine is then in more photos, and the server pools their readings), and a second photo
// of the same pause (EXTRA_MS later, if still held): the server keeps the better cut of
// each spine and votes on the readings.
const NEXT = 0.3;         // moved this share of the picture since the last photo: new books
const CHANGED = 18;       // or the picture changed this much (a book turned over, the next book)
const EXTRA_MS = 350;     // the second photo of a pause: at least this long after the first
const EXTRA_UNTIL = 1500; // and given up if the phone has not been held this long
const MIN_SHARP = 8;
const CODE_MS = 600;      // how often the live picture is looked at for a barcode
const SHAKE_KEY = 'seferehov.shake'; // the reader's tremor (steady.js), kept for next time

// 24 Nov 2026, "a steady moment, then a burst" (still.js; the camera above is kept as
// 'v0': localStorage['seferehov.camAlgo'] = 'v0'). Sessions of 14–23 Nov: 4.4 s from a new
// shelf to the photo (median), a 4K encode 3.2 s (up to 10.5 s), and ticks 1.8 s apart
// instead of 150 ms (full-size canvas copies and encodes on the page's thread). Now: the
// photo as soon as the hand is steady (motion sensors) and the picture in focus, one flash
// ("on to the next shelf"), then a few more frames silently; the best 2 are kept and only
// they are encoded, one at a time, off the page's thread. Frames are grabbed with
// createImageBitmap(video): no full-size copy on the page's thread.
const ALGO_KEY = 'seferehov.camAlgo';
const TICK_V1 = 100;      // ms between looks (picture speeds are still per 150 ms: still.imgSpeed)
const NEXT_V1 = 0.25;     // moved this share of the picture since the last photo: the next shelf
const FAST_IMG = 7;       // px per 150 ms: moving on, not at a shelf yet ("slower")
const LATE_MS = 1200;     // no steady moment this long after reaching a shelf: the best frame seen
const BURST_MS = 900;     // after the flash, more frames this long, quietly …
const BURST_EVERY = 200;  // … one every this many ms …
const BURST_MORE = 4;     // … at most this many …
const BURST_AWAY = 0.08;  // … while the picture stays within this share of the frame
const KEEP = 2;           // photos kept per shelf (the server pools their readings: "seen in 2 photos")
const QUALITY = 0.85;     // JPEG quality (0.9 before: ~25% bigger and slower)
const QUEUE_MAX = 3;      // photos waiting to be encoded; past it the oldest second photo is dropped

const algo = () => { try { return localStorage.getItem(ALGO_KEY) === 'v0' ? 'v0' : 'burst-v1'; } catch { return 'burst-v1'; } };

// iPhones give motion sensors only after the reader allows it, asked from a tap (the
// tap that opens the camera). Other phones have no such question: nothing is shown.
export function askMotion() {
  if (algo() === 'v0') return;
  try { globalThis.DeviceMotionEvent?.requestPermission?.().catch(() => {}); } catch { /* not from a tap */ }
}

const sessionId = () => crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

// guess: opened from the map, with no library or owner: the phone's hints go with the photos and
// the server guesses where they were taken (server/src/situation.js).
export function captureShots({ panel, request: given, onEnd, screen = 'library', guess = false }) {
  let hints = null, whereTimer = null, whereAt = null;
  const request = () => (guess ? { ...given(), guess: '1', hints: JSON.stringify(hints?.snapshot() ?? {}) } : given());
  let stream = null, video = null, timer = null, log = null, sid = null, opened = 0;
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, prevAt = 0, last = null, settleUntil = 0;
  let hand = null, gyro = { sum: 0, t: 0, now: null }, gaps = [];
  let speed = 0, moved = { x: 0, y: 0 }, lost = false, arrived = 0, steadySince = 0;
  let best = null, bestScore = 0, bestSharp = 0, spare = null, sharps = [];
  let ids = [], taken = 0, places = 0, saving = Promise.resolve(), code = null, codeAt = 0, codeLook = 0;
  let motion = { acc: 0, turn: 0 }, lastMotion = 0;
  let extra = null; // { at, until, sharp }: a second photo of this pause is wanted
  // burst-v1 (see ALGO_KEY):
  let mode = 'v0', sensors = null, imgRing = null, focusRing = null, shelfBest = null, burst = null;
  let pending = [], pumping = null, qMax = 0, bursts = { kept: 0, dropped: 0 }, failedBurst = null, burstNo = 0;
  // burst-v1 looks at the picture once per tick, through a canvas the GPU scales into (no
  // willReadFrequently), so only the small copy is read back. 24 Nov: two looks per tick into
  // willReadFrequently canvases (the whole 4K frame copied to memory for each) took 1.1 s per
  // tick on a reader's phone, a look every 2.9 s instead of 0.1 s.
  const look = document.createElement('canvas');
  const lookCtx = look.getContext('2d', { alpha: false });

  // The phone's own movement since the last photo: summed acceleration (gravity taken
  // out, m/s) and turning (degrees). Phones without the sensors leave both at 0.
  function onMotion(e) {
    const now = performance.now(), dt = lastMotion ? Math.min(0.2, (now - lastMotion) / 1000) : 0;
    lastMotion = now;
    const a = e.acceleration, r = e.rotationRate;
    if (a?.x != null) motion.acc += Math.hypot(a.x, a.y, a.z) * dt;
    if (r?.alpha != null) {
      const rate = Math.hypot(r.alpha, r.beta, r.gamma);
      motion.turn += rate * dt;
      gyro.sum += rate * dt; gyro.t += dt;
      gyro.now = gyro.now == null ? rate : 0.5 * rate + 0.5 * gyro.now; // ~the last 50 ms
    }
    if (sensors) { const v = still.motionSample(r, a); if (v != null) still.push(sensors, now, v); }
  }

  async function start() {
    askMotion(); // before any await: still within the reader's tap
    await stop(false);
    mode = algo();
    panel.hidden = false;
    panel.innerHTML = `<h2 class="shot-title">${t('capture.title')}</h2>
      <div class="shot-live burst"><video muted playsinline></video><div class="shot-flash"></div>
        <p class="shot-hint" hidden></p>${guess ? '<p class="shot-where" hidden></p>' : ''}
        <div class="burst-meter" data-state="hold"><span class="burst-bar"><i></i></span><b></b></div>
        <button class="shot-x" data-capture="end" aria-label="${t('capture.stop')}">✕</button>
        <button class="btn primary shot-stop on-cam" data-capture="end">■ ${t('capture.stop')} · <span class="burst-count">0</span></button></div>
      <div class="burst-thumbs"></div>
      <p class="shot-say"><b>${t('capture.how')}</b><br><span class="muted small">${t('capture.how2')}</span></p>
      <p class="shot-done"></p>`;
    video = panel.querySelector('video');
    sid = sessionId();
    const shake = Number(localStorage.getItem(SHAKE_KEY)) || null;
    hand = createHand({ shake, tick: TICK_MS });
    log = mode === 'v0' ? cameraLog('capture', { algo: 'v0', screen, steady: STEADY, rough: ROUGH, next: NEXT, pause: PAUSE_MS, capture: sid, shakeBefore: shake })
      : cameraLog('capture', { algo: mode, screen, tick: TICK_V1, next: NEXT_V1, late: LATE_MS, burstMs: BURST_MS, keep: KEEP, quality: QUALITY, imgStill: still.IMG_STILL, capture: sid });
    const askedAt = Date.now();
    try {
      // As many pixels as the camera gives: small print on spines needs them.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } });
      video.srcObject = stream;
      await video.play();
      log.opened(stream.getVideoTracks()[0], video, askedAt);
      if (guess) { hints = startHints(stream.getVideoTracks()[0]); whereTimer = setInterval(showWhere, 4000); }
    } catch (err) {
      log.failed(err);
      await stop();
      return false;
    }
    requestAnimationFrame(() => panel.querySelector('.shot-live')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    opened = Date.now();
    prev = null; last = null; speed = 0; lost = false; arrived = 0; steadySince = 0; sharps = []; taken = 0; places = 0; ids = []; code = null; extra = null; dropBest();
    motion = { acc: 0, turn: 0 }; lastMotion = 0; gyro = { sum: 0, t: 0, now: null }; gaps = [];
    sensors = mode === 'v0' ? null : still.createRing(); imgRing = still.createRing(); focusRing = still.createRing(still.FOCUS_MS);
    dropShelfBest(); burst = null; qMax = 0; bursts = { kept: 0, dropped: 0 }; failedBurst = null;
    addEventListener('devicemotion', onMotion);
    settleUntil = Date.now() + 700; // exposure and focus settle
    timer = setInterval(mode === 'v0' ? tick : tickV1, mode === 'v0' ? TICK_MS : TICK_V1);
    document.addEventListener('visibilitychange', onHidden);
    return true;
  }

  function show(state, fill, hint) {
    const m = panel.querySelector('.burst-meter');
    if (!m) return;
    if (m.dataset.state !== state) { m.dataset.state = state; m.querySelector('b').textContent = t(state === 'next' ? (mode === 'v0' ? 'capture.next' : 'capture.got') : `burst.${state}`); }
    m.querySelector('i').style.width = `${Math.round(100 * Math.min(1, Math.max(0, fill)))}%`;
    const hintEl = panel.querySelector('.shot-hint');
    hintEl.hidden = !hint;
    if (hint) hintEl.textContent = t(hint);
    log?.state(hint === 'shots.dark' ? 'dark' : hint === 'burst.slower' ? 'fast' : state);
  }

  // Sharpness = variance of the Laplacian of the grey copy.
  function sharpness(g, w, h) {
    let sum = 0, sq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sq += l * l; n++;
    }
    return sq / n - (sum / n) ** 2;
  }

  function lookForCode(now) {
    if (now - codeLook < CODE_MS) return;
    codeLook = now;
    detectFrame(video).then((c) => { if (c) { code = c; codeAt = Date.now(); } }).catch(() => {});
  }

  // A small grey copy of the picture now (ctx2 at w × h, or a crop of the video).
  function grey(c2, w, h, crop) {
    c2.canvas.width = w; c2.canvas.height = h;
    if (crop) c2.drawImage(video, ...crop, 0, 0, w, h); else c2.drawImage(video, 0, 0, w, h);
    const px = c2.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let bright = 0;
    for (let i = 0; i < g.length; i++) { g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; bright += g[i]; }
    return { g, bright: bright / g.length };
  }

  function tick() {
    if (!video?.videoWidth) return;
    const now = Date.now();
    const w = W, h = Math.round((w * video.videoHeight) / video.videoWidth);
    const { g, bright } = grey(ctx, w, h);
    const dark = bright < 55 ? 'shots.dark' : null;
    const t0 = performance.now();
    const step = prev?.length === g.length ? align(prev, g, w, h) : null;
    const dt = now - prevAt;
    prev = g; prevAt = now;
    if (!step) return;
    if (gaps.length < 400) gaps.push(dt);
    const turning = gyro.t > 0 ? gyro.sum / gyro.t : null;
    gyro.sum = 0; gyro.t = 0;
    const m = hand.step(now, { ...step, R }, dt, turning);
    speed = m.speed;
    if (m.skip) return; // a glitch: the phone did not move (slow frame, exposure)
    if (m.lost) lost = true; else { moved.x += step.dx; moved.y += step.dy; }
    const sharp = sharpness(g, w, h);
    if (now < settleUntil) return;
    log?.tick(m.v, step.edge, performance.now() - t0);
    const lim = limits(hand.shake);

    // The second photo of the pause: a sharp frame while still held there.
    if (extra) {
      if (now > extra.until || (speed > lim.rough && m.drift > lim.drift)) extra = null;
      else if (now >= extra.at && sharp >= 0.8 * extra.sharp) {
        extra = null;
        keepBest(frameScore(sharp, m.v, gyro.now), sharp, g, true);
        take('extra');
        return;
      }
    }
    // How far from the last photo (1 = a new view: moved along, or a new cover).
    let along = 1;
    if (last) {
      const changed = last.length === g.length ? cost(last, g, w, h, mean(last), mean(g), 0, 0, 3) : 99;
      along = changed >= CHANGED ? 1 : Math.max(lost ? changed / CHANGED : 0, Math.max(Math.abs(moved.x) / w, Math.abs(moved.y) / h) / NEXT);
    }
    const slower = speed > lim.fast && m.drift > lim.drift ? 'burst.slower' : dark;
    if (along < 1) { arrived = 0; steadySince = 0; dropBest(); show('next', along, slower); return; }
    arrived ||= now;
    if (speed <= lim.steady) steadySince ||= now; else steadySince = 0;
    const d = decide({ now, arrived, steadySince, speed, drift: m.drift, best, bestSharp, typical: typicalSharp(), lim });
    if (!d.holding) {
      arrived = 0; steadySince = 0; dropBest();
      show('hold', 0, slower);
      return;
    }
    hand.learn(m.v);
    lookForCode(now);
    const score = frameScore(sharp, m.v, gyro.now);
    if (sharp > MIN_SHARP && score > bestScore) keepBest(score, sharp, g);
    const d2 = decide({ now, arrived, steadySince, speed, drift: m.drift, best, bestSharp, typical: typicalSharp(), lim });
    show('hold', d2.fill, dark);
    if (d2.take) take(d2.take);
  }

  function typicalSharp() {
    if (sharps.length < 2) return MIN_SHARP;
    const s = [...sharps].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
  // A full-size copy of the frame now (costly at 4K: only for a clearly better frame).
  function keepBest(score, sharp, g, always = false) {
    if (!always && best && score < 1.1 * bestScore) return;
    const c = spare ?? document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    spare = best; best = c; best.grey = g; bestScore = score; bestSharp = sharp;
  }
  function dropBest() {
    if (best) spare = best;
    best = null; bestScore = 0; bestSharp = 0;
  }

  function take(how) {
    const c = best, lg = log, seq = taken++, at = Date.now() - opened;
    const travel = +Math.max(Math.abs(moved.x) / small.width, Math.abs(moved.y) / (small.height || 1)).toFixed(2);
    if (how !== 'extra') extra = { at: Date.now() + EXTRA_MS, until: Date.now() + EXTRA_UNTIL, sharp: bestSharp };
    const meta = { how, extra: how === 'extra', sharp: Math.round(bestSharp), speed: +speed.toFixed(2), travel, lost,
      shake: hand?.shake == null ? null : +hand.shake.toFixed(2), gyro: gyro.now == null ? null : Math.round(gyro.now),
      acc: +motion.acc.toFixed(2), turn: Math.round(motion.turn), codes: code && Date.now() - codeAt < 2500 ? [code] : [] };
    const rec = lg?.photo(how, bestSharp, speed, { wait: arrived ? Date.now() - arrived : null, w: c.width, h: c.height, seq, travel, acc: meta.acc, turn: meta.turn, code: !!meta.codes.length });
    if (how === 'steady') sharps = [...sharps.slice(-9), bestSharp];
    last = c.grey;
    moved = { x: 0, y: 0 }; lost = false; arrived = 0; steadySince = 0; code = null;
    motion = { acc: 0, turn: 0 };
    best = null; bestScore = 0; bestSharp = 0;
    spare = null; // c is handed over
    if (how !== 'extra') { // the second photo of a pause is taken quietly
      const flash = panel.querySelector('.shot-flash');
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
      navigator.vibrate?.(30);
    }
    if (how !== 'extra') places++;
    panel.querySelector('.burst-count').textContent = places; // second photos of a pause are not counted
    show('next', 0, null);
    const fields = { ...request(), session: sid, seq, at, meta: JSON.stringify(meta) };
    saving = saving.then(async () => {
      const t0 = performance.now();
      // Full size, encoded once: spines are thin, the server needs every pixel to read them.
      // Off the page's thread where the browser can (a 4K photo took ~9 s on a reader's
      // phone, and the steadiness checks stalled meanwhile).
      const blob = await encodeJpeg(c, 0.9);
      if (rec) { rec.encMs = Math.round(performance.now() - t0); rec.kb = Math.round(blob.size / 1024); }
      panel.querySelector('.burst-thumbs')?.insertAdjacentHTML('afterbegin', `<img src="${esc(URL.createObjectURL(blob))}" alt="">`);
      const id = await enqueue('/api/captures', fields, { photo: blob }, 'capture', { session: lg?.id });
      lg?.upload(id, 'capture');
      ids.push(id);
    }).catch((err) => console.warn('photo not saved', err));
  }

  // ---- burst-v1: a steady moment, then a burst ------------------------------------------
  // One look: the picture at 2 × W wide (scaled by the GPU, one small read back), giving the
  // grey copy at W wide (2 × 2 averaged) and the centre 60% for focus (192 px wide).
  function lookV1(vw, vh) {
    const h = Math.round((W * vh) / vw), w2 = 2 * W, h2 = 2 * h;
    if (look.width !== w2 || look.height !== h2) { look.width = w2; look.height = h2; }
    lookCtx.drawImage(video, 0, 0, w2, h2);
    const px = lookCtx.getImageData(0, 0, w2, h2).data;
    const big = new Float32Array(w2 * h2);
    for (let i = 0; i < big.length; i++) big[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const g = new Float32Array(W * h);
    let bright = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
      const i = 2 * y * w2 + 2 * x;
      const v = (big[i] + big[i + 1] + big[i + w2] + big[i + w2 + 1]) / 4;
      g[y * W + x] = v; bright += v;
    }
    const mx = Math.round(0.2 * w2), my = Math.round(0.2 * h2), mw = Math.round(0.6 * w2), mh = Math.round(0.6 * h2);
    const m = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) m.set(big.subarray((my + y) * w2 + mx, (my + y) * w2 + mx + mw), y * mw);
    return { g, w: W, h, bright: bright / g.length, m, mw, mh };
  }

  function tickV1() {
    if (!video?.videoWidth) return;
    const now = Date.now(), pnow = performance.now();
    const vw = video.videoWidth, vh = video.videoHeight;
    const t0 = performance.now(); // the tick's own time (camlog alignMs) now includes the look
    const { g, w, h, bright, m, mw, mh } = lookV1(vw, vh);
    const dark = bright < 55 ? 'shots.dark' : null;
    const step = prev?.length === g.length ? align(prev, g, w, h) : null;
    const dt = now - prevAt;
    prev = g; prevAt = now;
    if (!step) return;
    if (gaps.length < 400) gaps.push(dt);
    // Focus: the centre 60% of the picture.
    const sharp = sharpness(m, mw, mh);
    const v = step.edge ? 2 * R : still.imgSpeed(step.dx, step.dy, dt);
    speed = v;
    if (step.edge) lost = true; else { moved.x += step.dx; moved.y += step.dy; if (burst) { burst.x += step.dx; burst.y += step.dy; } }
    still.push(imgRing, pnow, v);
    still.push(focusRing, pnow, sharp);
    if (now < settleUntil) return;
    log?.tick(v, step.edge, performance.now() - t0);
    const st = still.steady(sensors, imgRing, pnow, arrived ? now - arrived : 0);
    const score = still.frameScore(sharp, st.shake);

    if (burst) {
      if (now - burst.at >= BURST_MS || step.edge || Math.max(Math.abs(burst.x) / w, Math.abs(burst.y) / h) > BURST_AWAY) endBurst();
      else if (now - burst.lastAt >= BURST_EVERY && burst.tries < BURST_MORE) more({ sharp, shake: st.shake, score, v, x: burst.x, y: burst.y, at: now, g, by: st.by });
    }
    let along = 1;
    if (last) {
      const changed = last.length === g.length ? cost(last, g, w, h, mean(last), mean(g), 0, 0, 3) : 99;
      along = changed >= CHANGED ? 1 : Math.max(lost ? changed / CHANGED : 0, Math.max(Math.abs(moved.x) / w, Math.abs(moved.y) / h) / NEXT_V1);
    }
    const fast = v > FAST_IMG || (st.by === 'sensors' && st.shake > still.SHAKE_CEIL);
    if (along < 1) { arrived = 0; dropShelfBest(); show('next', along, fast ? 'burst.slower' : dark); return; }
    if (fast) { arrived = 0; dropShelfBest(); show('hold', 0, 'burst.slower'); return; }
    arrived ||= now;
    lookForCode(now);
    const frame = { sharp, shake: st.shake, score, v, x: 0, y: 0, at: now, g, by: st.by };
    if (st.steady && sharp > MIN_SHARP && still.focusOk(focusRing, pnow, sharp)) { fire('steady', { ...frame, bmp: grab() }); return; }
    // No steady moment yet: keep the best frame seen at this shelf, for LATE_MS.
    if (sharp > MIN_SHARP && (!shelfBest || score > 1.1 * shelfBest.score)) { dropShelfBest(); shelfBest = { ...frame, bmp: grab() }; }
    if (shelfBest && now - arrived >= LATE_MS) { const f = shelfBest; shelfBest = null; fire('late', f); return; }
    show('hold', (now - arrived) / LATE_MS, dark);
  }

  const grab = () => createImageBitmap(video).catch(() => null);
  const closeBmp = (p) => { p?.then((b) => b?.close?.()).catch(() => {}); };
  function dropShelfBest() { if (shelfBest) closeBmp(shelfBest.bmp); shelfBest = null; }

  // The photo: one flash, and the reader can move on. More frames follow quietly (more()).
  function fire(trigger, frame) {
    const now = Date.now();
    if (burst) endBurst();
    dropShelfBest();
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(30);
    places++;
    panel.querySelector('.burst-count').textContent = places;
    const travel = +Math.max(Math.abs(moved.x) / small.width, Math.abs(moved.y) / (small.height || 1)).toFixed(2);
    burst = { id: ++burstNo, trigger, at: now, lastAt: now, tries: 0, dropped: 0, x: 0, y: 0, items: [frame],
      toFlash: arrived ? now - arrived : null, travel, lost, acc: +motion.acc.toFixed(2), turn: Math.round(motion.turn),
      codes: code && now - codeAt < 2500 ? [code] : [], req: request() };
    log?.count(`trigger_${trigger}`);
    log?.count(`by_${frame.by ?? 'none'}`);
    last = frame.g;
    moved = { x: 0, y: 0 }; lost = false; arrived = 0; code = null;
    motion = { acc: 0, turn: 0 };
    show('next', 0, null);
  }

  // A frame of the burst: grabbed only if it would be among the best KEEP.
  function more(c) {
    burst.lastAt = c.at; burst.tries++;
    const keep = still.pickBest([...burst.items, c], KEEP);
    if (!keep.includes(c)) { burst.dropped++; return; }
    c.bmp = grab();
    for (const o of burst.items) if (!keep.includes(o)) { closeBmp(o.bmp); burst.dropped++; }
    burst.items = keep;
  }

  function endBurst() {
    const b = burst;
    burst = null;
    const kept = still.pickBest(b.items, KEEP);
    for (const o of b.items) if (!kept.includes(o)) { closeBmp(o.bmp); b.dropped++; }
    bursts.kept += kept.length; bursts.dropped += b.dropped;
    kept.forEach((it, rank) => queuePhoto(it, rank, b));
  }

  function queuePhoto(it, rank, b) {
    const how = rank ? 'burst2' : 'burst1';
    const info = { n: b.tries + 1, rank: rank + 1, score: Math.round(it.score), shake: it.shake == null ? null : +it.shake.toFixed(2) };
    const meta = { how, extra: rank > 0, algo: mode, trigger: b.trigger, sharp: Math.round(it.sharp), speed: +it.v.toFixed(2), travel: b.travel, lost: b.lost,
      shake: info.shake, by: it.by ?? null, acc: b.acc, turn: b.turn, codes: b.codes, burst: info };
    const rec = log?.photo(how, it.sharp, it.v, { wait: rank ? null : b.toFlash, toFlash: rank ? null : b.toFlash, travel: b.travel, acc: b.acc, turn: b.turn,
      code: !!b.codes.length, trigger: b.trigger, burst: { ...info, dropped: b.dropped } });
    pending.push({ bmp: it.bmp, how, meta, rec, lg: log, burst: b.id, at: it.at - opened, req: b.req });
    // Too many waiting (a slow phone): the oldest second photo goes first. A shelf's
    // first photo is never dropped.
    while (pending.length > QUEUE_MAX) {
      const i = pending.findIndex((j) => j.how === 'burst2');
      if (i < 0) break;
      closeBmp(pending[i].bmp);
      pending.splice(i, 1);
      log?.count('queue_dropped');
    }
    qMax = Math.max(qMax, pending.length + (pumping ? 1 : 0));
    pump();
  }

  // Encodes the kept photos one at a time, off the page's thread, and puts each in the
  // outbox. Ticks never wait for it. seq counts only photos that reached the outbox, so
  // the number told to the server at the end is right.
  function pump() {
    pumping ??= (async () => {
      for (let j; (j = pending.shift());) {
        const lg = j.lg;
        try {
          const bmp = await j.bmp;
          if (!bmp) throw new Error('no frame');
          if (j.how === 'burst2' && failedBurst === j.burst) { j.how = 'burst1'; j.meta = { ...j.meta, how: 'burst1', extra: false }; } // its first is lost: it stands alone
          const seq = taken, t0 = performance.now();
          if (j.rec) { j.rec.seq = seq; j.rec.w = bmp.width; j.rec.h = bmp.height; }
          const blob = await encodeBitmap(bmp, QUALITY);
          if (j.rec) { j.rec.encMs = Math.round(performance.now() - t0); j.rec.kb = Math.round(blob.size / 1024); }
          const id = await enqueue('/api/captures', { ...j.req, session: sid, seq, at: j.at, meta: JSON.stringify(j.meta) }, { photo: blob }, 'capture', { session: lg?.id });
          taken++;
          panel.querySelector('.burst-thumbs')?.insertAdjacentHTML('afterbegin', `<img src="${esc(URL.createObjectURL(blob))}" alt="">`);
          lg?.upload(id, 'capture');
          ids.push(id);
        } catch (err) {
          if (j.how === 'burst1') failedBurst = j.burst;
          console.warn('photo not saved', err);
        }
      }
    })().finally(() => { pumping = null; });
    return pumping;
  }

  const onHidden = () => { if (document.visibilityState === 'hidden' && stream) stop('hidden'); };

  // how: true = ✕ or Done; 'hidden' = screen off or another app; false = the screen is
  // closed. The log goes first (a hidden page may be frozen at any await), then the
  // photos still being saved, then the "n photos" note to the server.
  // The phone's first guess of where the reader is, at the top of the camera (the server decides).
  async function showWhere() {
    const el = panel.querySelector('.shot-where');
    if (!el || !hints) return;
    const h = hints.snapshot();
    let text = null;
    if (h.nearHome) text = `🏠 ${t('camwhere.home')}`;
    else if (h.lat != null) {
      if (!whereAt || metresMoved(whereAt, h) > 30) {
        whereAt = { lat: h.lat, lon: h.lon, libs: await api(`/api/locations/near?lat=${h.lat}&lon=${h.lon}`).then((r) => r.libraries).catch(() => null) };
      }
      const lib = whereAt.libs?.[0];
      text = lib && lib.m <= 80 ? `📍 ${t('camwhere.near', { name: lib.name || t('free_library'), m: lib.m })}`
        : h.net === 'wifi' || h.acc > 40 ? `🏠 ${t('camwhere.home_maybe')}` : `📍 ${t('camwhere.new')}`;
    }
    el.hidden = !text;
    if (text) el.textContent = text;
  }
  const metresMoved = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lon - b.lon) * 111000 * Math.cos(a.lat * Math.PI / 180));

  async function stop(how = true) {
    if (burst) endBurst(); // its photos are kept
    dropShelfBest();
    const running = !!stream, id = sid;
    let n = taken + pending.length + (pumping ? 1 : 0);
    clearInterval(whereTimer);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHidden);
    removeEventListener('devicemotion', onMotion);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    best = null; spare = null;
    const gs = [...gaps].sort((a, b) => a - b);
    const gap = { gapMs: gs.length ? Math.round(gs[gs.length >> 1]) : null, gapSlow: gs.length ? Math.round(gs[Math.floor(gs.length * 0.9)]) : null };
    if (mode === 'v0' && hand?.shake != null) {
      try { localStorage.setItem(SHAKE_KEY, hand.shake.toFixed(2)); } catch { /* private mode */ }
      log?.event('hand', { shake: +hand.shake.toFixed(2), ...gap });
    } else if (mode !== 'v0' && log) {
      log.event('hand', { ...gap, places, qMax, kept: bursts.kept, dropped: bursts.dropped, sensors: !!sensors?.s.length });
    }
    log?.end(how === true ? 'done' : how || 'left');
    log = null;
    if (!running) return;
    if (how === true && n) panel.innerHTML = `<p class="shot-done"><span class="spinner"></span> ${t('capture.saving')}</p>`;
    await saving;
    await pumping;
    n = taken;
    let end = null;
    if (n) end = await enqueue(`/api/captures/${id}/end`, { ...request(), n }, {}, 'capture-end', { keepFailed: false }).catch(() => null);
    if (hints) { rememberSession(id, hints.fix); hints.stop(); hints = null; }
    kick();
    if (how === false) return;
    panel.hidden = !n;
    panel.innerHTML = n ? `${how === 'hidden' ? `<p class="shot-done">${t('burst.closed_hidden')}</p>` : ''}
      <p class="shot-done shot-progress"></p><p class="shot-done">${t(guess ? 'capture.sent_guess' : 'capture.sent', { n })} <a href="/queue">${t('capture.queue')}</a></p>` : '';
    if (n) follow(ids, end, panel.querySelector('.shot-progress'));
    onEnd?.(n);
  }

  // "3 of 12 sent", until all are on the server: then the phone can be put away.
  // Photos sent "3 of 12", until all are on the server: then the phone can be put away.
  // Some may have gone already (no event will come for them): only those still in the
  // outbox are waited for.
  async function follow(photos, end, el) {
    const list = [...photos, end].filter(Boolean);
    const left = new Set(list);
    let why = null;
    const draw = () => {
      const done = photos.filter((i) => !left.has(i)).length;
      el.innerHTML = left.size ? `<span class="spinner"></span> ${t('capture.sending', { done, n: photos.length })}${why ? ` · ${t(`out.waiting_${why}`)}` : ''}`
        : `✓ ${t('capture.all_sent', { n: photos.length })}`;
    };
    for (const i of list) onItem(i, (state, info) => {
      if (state === 'sent' || (state === 'failed' && info?.dropped)) left.delete(i);
      why = state === 'waiting' ? info : null;
      draw();
    });
    const still = new Set((await unsentItems()).map((x) => x.id));
    for (const i of list) if (!still.has(i)) left.delete(i);
    draw();
  }

  panel.addEventListener('click', (e) => { if (e.target.closest('[data-capture="end"]')) stop(); });
  return { start, stop, available: !!navigator.mediaDevices?.getUserMedia };
}

// Photos picked from the phone's gallery or camera app: one session, sent at once, sorted
// the same way (no timing or motion: their order is all the server has).
export async function captureFiles(files, request) {
  const sid = sessionId();
  const picked = [...files].slice(0, 40);
  for (const [seq, f] of picked.entries()) {
    await enqueue('/api/captures', { ...request(), session: sid, seq, at: '', meta: JSON.stringify({ how: 'file' }) }, { photo: await shrinkImage(f, 4000) }, 'capture');
  }
  if (picked.length) await enqueue(`/api/captures/${sid}/end`, { ...request(), n: picked.length }, {}, 'capture-end', { keepFailed: false });
  return picked.length;
}
