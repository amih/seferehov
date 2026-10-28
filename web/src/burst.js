import { esc, shrinkImage } from './ui.js';
import { t } from './i18n.js';
import { cameraLog } from './camlog.js';

// Shelf photos taken by themselves: the reader moves the phone along the shelves and
// stops for a moment at each group of spines. The camera is looked at about 7 times a
// second (a tiny grey copy: cheap). Each look is lined up with the one before (the shift
// that makes them match best), so the phone's speed is known apart from how busy the
// picture is: on a shelf full of spines a shaking hand changed the plain difference as
// much as moving on did, and readers could not hold still enough for a photo. The shifts
// are added up since the last photo, so it is also known how far the camera has moved
// along the shelf. Once it has moved on far enough (NEXT of the picture) and slows down,
// the sharpest frame of the pause is kept, full size: after PAUSE_MS held steady, or
// after ROUGH_MS held only roughly steady (a shaky hand still gets its photo). A bar on
// the picture says what it is waiting for: hold steady (it fills), move on, slower.
// Every BATCH photos go to onBatch(blobs) as one scan, in the background (its photos are
// read together, so a spine seen in two of them counts once); the rest when the reader
// stops. onBatch resolves to a line to show. Without a live camera, start() returns false.
// When the screen goes off or the reader switches apps (the phone put in a pocket), or
// leaves the screen, the camera stops and the photos not sent yet go to park(blobs),
// which keeps them on the phone (queue.js) until they can be sent: before, they were in
// memory only and were lost.
// Each session's numbers (speeds, waits, photos, how it ended) go to /api/camera-log
// (camlog.js), so the limits can be set from real shelves, not guessed.
const TICK_MS = 150;
const BATCH = 8;
const W = 160;            // width of the grey copy; speeds are in its pixels per tick
const R = 10;             // largest shift looked for per tick; faster = moving on
const STEADY = 1;         // px/tick: held steady
const ROUGH = 2.5;        // px/tick: roughly steady (frames still worth keeping)
const FAST = 6;           // px/tick: too fast (the "slower" hint)
const NEXT = 0.4;         // moved this share of the picture since the last photo: new books
const CHANGED = 18;       // or the picture changed this much (moved closer, lost track)
const PAUSE_MS = 400;
const ROUGH_MS = 1500;
const MIN_SHARP = 8;

// Mean grey difference of b shifted by (dx, dy) from a, brightness change removed.
function cost(a, b, w, h, ma, mb, dx, dy, s) {
  let d = 0, c = 0;
  const off = mb - ma;
  for (let y = R; y < h - R; y += s) {
    const ra = y * w, rb = (y + dy) * w + dx;
    for (let x = R; x < w - R; x += s) { d += Math.abs(b[rb + x] - a[ra + x] - off); c++; }
  }
  return d / c;
}
const mean = (g) => { let m = 0; for (let i = 0; i < g.length; i++) m += g[i]; return m / g.length; };
// The shift that lines b up with a: every second shift on a coarse grid, then the best's neighbours.
function align(a, b, w, h) {
  const ma = mean(a), mb = mean(b);
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
    const err = cost(a, b, w, h, ma, mb, dx, dy, 4);
    if (err < best.err) best = { dx, dy, err };
  }
  const c = best;
  best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = c.dy - 1; dy <= c.dy + 1; dy++) for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
    if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
    const err = cost(a, b, w, h, ma, mb, dx, dy, 3);
    if (err < best.err) best = { dx, dy, err };
  }
  best.edge = Math.max(Math.abs(best.dx), Math.abs(best.dy)) >= R - 1;
  best.plain = cost(a, b, w, h, ma, mb, 0, 0, 3);
  return best;
}

export function burstShots({ panel, onBatch, park, onEnd, screen = 'library' }) {
  let stream = null, video = null, timer = null, log = null;
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, prevAt = 0, last = null, settleUntil = 0;
  let speed = 0, moved = { x: 0, y: 0 }, lost = false, arrived = 0, steadySince = 0;
  let best = null, bestScore = 0, bestSharp = 0, spare = null, sharps = [];
  let batch = [], taken = 0, saving = Promise.resolve();

  async function start() {
    stop(false);
    panel.hidden = false;
    panel.innerHTML = `<h2 class="shot-title">${t('burst.title')}</h2>
      <div class="shot-live burst"><video muted playsinline></video><div class="shot-flash"></div>
        <p class="shot-hint" hidden></p><span class="burst-count">0</span>
        <div class="burst-meter" data-state="hold"><span class="burst-bar"><i></i></span><b></b></div>
        <button class="shot-x" data-burst="end" aria-label="${t('burst.stop')}">✕</button></div>
      <p class="shot-say"><b>${t('burst.how')}</b><br><span class="muted small">${t('burst.how2')}</span></p>
      <div class="burst-thumbs"></div>
      <button class="btn primary shot-stop" data-burst="end">✓ ${t('burst.stop')}</button>
      <ul class="shot-done"></ul>`;
    video = panel.querySelector('video');
    try {
      // As many pixels as the camera gives: small print on the spines needs them.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } });
      video.srcObject = stream;
      await video.play();
    } catch {
      stop();
      return false;
    }
    requestAnimationFrame(() => panel.querySelector('.shot-live')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    prev = null; last = null; speed = 0; lost = false; arrived = 0; steadySince = 0; sharps = []; dropBest();
    settleUntil = Date.now() + 700; // exposure and focus settle
    log = cameraLog('shelf', { screen, cam: `${video.videoWidth}x${video.videoHeight}`, steady: STEADY, rough: ROUGH, next: NEXT });
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', onHidden);
    return true;
  }

  function show(state, fill, hint) {
    const m = panel.querySelector('.burst-meter');
    if (!m) return;
    if (m.dataset.state !== state) { m.dataset.state = state; m.querySelector('b').textContent = t(`burst.${state}`); }
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

  function tick() {
    if (!video?.videoWidth) return;
    const now = Date.now();
    const w = W, h = Math.round((w * video.videoHeight) / video.videoWidth);
    small.width = w; small.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let bright = 0;
    for (let i = 0; i < g.length; i++) { g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; bright += g[i]; }
    const dark = bright / g.length < 55 ? 'shots.dark' : null;
    const t0 = performance.now();
    const step = prev?.length === g.length ? align(prev, g, w, h) : null;
    const dt = Math.min(3 * TICK_MS, Math.max(TICK_MS / 2, now - prevAt));
    prev = g; prevAt = now;
    if (!step) return;
    const v = step.edge ? 2 * R : Math.hypot(step.dx, step.dy) * (TICK_MS / dt);
    speed = 0.6 * v + 0.4 * speed;
    if (step.edge) lost = true; else { moved.x += step.dx; moved.y += step.dy; }
    const sharp = sharpness(g, w, h);
    if (now < settleUntil) return;

    // How far along since the last photo (1 = far enough for new books).
    let along = 1;
    if (last) {
      const changed = last.length === g.length ? cost(last, g, w, h, mean(last), mean(g), 0, 0, 3) : 99;
      along = changed >= CHANGED ? 1 : lost ? changed / CHANGED : Math.max(Math.abs(moved.x) / w, Math.abs(moved.y) / h) / NEXT;
    }
    log?.tick(v, step.edge, performance.now() - t0);

    if (along < 1) { arrived = 0; steadySince = 0; dropBest(); show('next', along, speed > FAST ? 'burst.slower' : dark); return; }
    if (speed > ROUGH) {
      // Moving again before the photo was taken: the best frame of the pause still counts.
      if (best && now - arrived >= PAUSE_MS) take('leaving');
      arrived = 0; steadySince = 0; dropBest();
      show('hold', 0, speed > FAST ? 'burst.slower' : dark);
      return;
    }
    arrived ||= now;
    if (speed <= STEADY) steadySince ||= now; else steadySince = 0;
    const score = sharp / (1 + speed);
    if (sharp > MIN_SHARP && score > bestScore) keepBest(score, sharp, g);
    const fill = Math.max(steadySince ? (now - steadySince) / PAUSE_MS : 0, (now - arrived) / ROUGH_MS);
    show('hold', fill, dark);
    if (!best) return;
    if (steadySince && now - steadySince >= PAUSE_MS) take('steady');
    else if (now - arrived >= ROUGH_MS && bestSharp >= 0.6 * typicalSharp()) take('rough');
  }

  // Sharpness of the photos taken while steady (a rough photo must come near it).
  function typicalSharp() {
    if (sharps.length < 2) return MIN_SHARP;
    const s = [...sharps].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function keepBest(score, sharp, g) {
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
    const c = best;
    log?.photo(how, bestSharp, speed);
    if (how === 'steady') sharps = [...sharps.slice(-9), bestSharp];
    last = c.grey;
    moved = { x: 0, y: 0 }; lost = false; arrived = 0; steadySince = 0;
    best = null; bestScore = 0; bestSharp = 0;
    spare = null; // c is handed over; a new canvas next time
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(30);
    panel.querySelector('.burst-count').textContent = ++taken;
    show('next', 0, null);
    saving = saving.then(async () => {
      const blob = await shrinkImage(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92)), 2400);
      panel.querySelector('.burst-thumbs')?.insertAdjacentHTML('afterbegin', `<img src="${esc(URL.createObjectURL(blob))}" alt="">`);
      batch.push(blob);
      if (batch.length >= BATCH) send();
    }).catch(() => {});
  }

  function send() {
    if (!batch.length) return;
    const blobs = batch;
    batch = [];
    log?.batch();
    const li = document.createElement('li');
    li.innerHTML = `<span class="spinner"></span> ${esc(t('add3.photos_n', { n: blobs.length }))}`;
    panel.querySelector('.shot-done')?.prepend(li);
    onBatch(blobs).then((line) => { li.innerHTML = line; }, (err) => { li.textContent = `⚠️ ${err.message}`; });
  }

  const onHidden = () => { if (document.visibilityState === 'hidden' && stream) stop('hidden'); };

  // Kept on the phone and sent from there (park), or sent now if there is no park.
  function keep() {
    if (!batch.length) return Promise.resolve();
    const blobs = batch;
    batch = [];
    log?.batch();
    const li = document.createElement('li');
    li.textContent = `💾 ${t('burst.parked', { n: blobs.length })}`;
    panel.querySelector('.shot-done')?.prepend(li);
    return (park ? park(blobs) : onBatch(blobs)).catch((err) => { li.textContent = `⚠️ ${err.message}`; });
  }

  // how: true = "Done": send what is left; 'hidden' = screen off or another app; false =
  // the screen is closed. The camera closes; the lines of what was sent stay.
  async function stop(how = true) {
    const running = !!stream;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHidden);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    best = null; spare = null;
    log?.end(how === true ? 'done' : how || 'left');
    log = null;
    if (how !== true && !running) return;
    await saving; // the last photo may still be being shrunk
    if (how === true) send(); else await keep();
    if (how === false) return;
    const sent = panel.querySelector('.shot-done');
    panel.innerHTML = '';
    if (sent?.children.length) panel.append(sent); else panel.hidden = true;
    taken = 0;
    onEnd?.();
  }

  panel.addEventListener('click', (e) => { if (e.target.closest('[data-burst="end"]')) stop(); });
  return { start, stop, available: !!navigator.mediaDevices?.getUserMedia };
}
