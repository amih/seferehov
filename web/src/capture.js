import { esc, shrinkImage } from './ui.js';
import { t } from './i18n.js';
import { cameraLog } from './camlog.js';
import { enqueue, kick, onItem, unsentItems } from './queue.js';
import { detectFrame } from './scanner.js';
import { align, cost, mean, R } from './motion.js';

// One camera for every book photo, free style: shelves (spines), front covers and back
// covers, in any order. The phone only takes the photos; the server works out what each
// one shows and which front goes with which back (server/src/pairing.js). On 3 Nov 2026
// the phone's own guess (turned over = same book, moved sideways = next book) split three
// books into six: a book turned over on a shelf moves in the picture just as the phone
// moving on does.
//
// A photo is taken when the picture has changed since the last photo (moved along the
// shelf, or a new cover: a book turned over, the next book) and the phone is then held
// steady for PAUSE_MS (or roughly steady for ROUGH_MS); the sharpest frame of the pause
// is kept, full size. Each photo is saved on the phone at once and sent by itself
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
const STEADY = 1.5;       // px/tick: held steady
const ROUGH = 3.5;        // px/tick: roughly steady
const FAST = 7;           // px/tick: "slower"
const NEXT = 0.3;         // moved this share of the picture since the last photo: new books
const CHANGED = 18;       // or the picture changed this much (a book turned over, the next book)
const PAUSE_MS = 450;     // steady this long: photo (400 ms caught books mid-turn)
const ROUGH_MS = 900;
const EXTRA_MS = 350;     // the second photo of a pause: at least this long after the first
const EXTRA_UNTIL = 1500; // and given up if the phone has not been held this long
const MIN_SHARP = 8;
const CODE_MS = 600;      // how often the live picture is looked at for a barcode

const sessionId = () => crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

export function captureShots({ panel, request, onEnd, screen = 'library' }) {
  let stream = null, video = null, timer = null, log = null, sid = null, opened = 0;
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, prevAt = 0, last = null, settleUntil = 0;
  let speed = 0, moved = { x: 0, y: 0 }, lost = false, arrived = 0, steadySince = 0;
  let best = null, bestScore = 0, bestSharp = 0, spare = null, sharps = [];
  let ids = [], taken = 0, places = 0, saving = Promise.resolve(), code = null, codeAt = 0, codeLook = 0;
  let motion = { acc: 0, turn: 0 }, lastMotion = 0;
  let extra = null; // { at, until, sharp }: a second photo of this pause is wanted

  // The phone's own movement since the last photo: summed acceleration (gravity taken
  // out, m/s) and turning (degrees). Phones without the sensors leave both at 0.
  function onMotion(e) {
    const now = performance.now(), dt = lastMotion ? Math.min(0.2, (now - lastMotion) / 1000) : 0;
    lastMotion = now;
    const a = e.acceleration, r = e.rotationRate;
    if (a?.x != null) motion.acc += Math.hypot(a.x, a.y, a.z) * dt;
    if (r?.alpha != null) motion.turn += Math.hypot(r.alpha, r.beta, r.gamma) * dt;
  }

  async function start() {
    await stop(false);
    panel.hidden = false;
    panel.innerHTML = `<h2 class="shot-title">${t('capture.title')}</h2>
      <div class="shot-live burst"><video muted playsinline></video><div class="shot-flash"></div>
        <p class="shot-hint" hidden></p>
        <div class="burst-meter" data-state="hold"><span class="burst-bar"><i></i></span><b></b></div>
        <button class="shot-x" data-capture="end" aria-label="${t('capture.stop')}">✕</button>
        <button class="btn primary shot-stop on-cam" data-capture="end">■ ${t('capture.stop')} · <span class="burst-count">0</span></button></div>
      <div class="burst-thumbs"></div>
      <p class="shot-say"><b>${t('capture.how')}</b><br><span class="muted small">${t('capture.how2')}</span></p>
      <p class="shot-done"></p>`;
    video = panel.querySelector('video');
    sid = sessionId();
    log = cameraLog('capture', { screen, steady: STEADY, rough: ROUGH, next: NEXT, pause: PAUSE_MS, capture: sid });
    const askedAt = Date.now();
    try {
      // As many pixels as the camera gives: small print on spines needs them.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } });
      video.srcObject = stream;
      await video.play();
      log.opened(stream.getVideoTracks()[0], video, askedAt);
    } catch (err) {
      log.failed(err);
      await stop();
      return false;
    }
    requestAnimationFrame(() => panel.querySelector('.shot-live')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    opened = Date.now();
    prev = null; last = null; speed = 0; lost = false; arrived = 0; steadySince = 0; sharps = []; taken = 0; places = 0; ids = []; code = null; extra = null; dropBest();
    motion = { acc: 0, turn: 0 }; lastMotion = 0;
    addEventListener('devicemotion', onMotion);
    settleUntil = Date.now() + 700; // exposure and focus settle
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', onHidden);
    return true;
  }

  function show(state, fill, hint) {
    const m = panel.querySelector('.burst-meter');
    if (!m) return;
    if (m.dataset.state !== state) { m.dataset.state = state; m.querySelector('b').textContent = t(state === 'next' ? 'capture.next' : `burst.${state}`); }
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
    log?.tick(v, step.edge, performance.now() - t0);

    // The second photo of the pause: a sharp frame while still held there.
    if (extra) {
      if (now > extra.until || speed > ROUGH) extra = null;
      else if (now >= extra.at && sharp >= 0.8 * extra.sharp) {
        extra = null;
        keepBest(sharp / (1 + speed), sharp, g);
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
    if (along < 1) { arrived = 0; steadySince = 0; dropBest(); show('next', along, speed > FAST ? 'burst.slower' : dark); return; }
    if (speed > ROUGH) {
      arrived = 0; steadySince = 0; dropBest();
      show('hold', 0, speed > FAST ? 'burst.slower' : dark);
      return;
    }
    arrived ||= now;
    lookForCode(now);
    if (speed <= STEADY) steadySince ||= now; else steadySince = 0;
    const score = sharp / (1 + speed);
    if (sharp > MIN_SHARP && score > bestScore) keepBest(score, sharp, g);
    const fill = Math.max(steadySince ? (now - steadySince) / PAUSE_MS : 0, (now - arrived) / ROUGH_MS);
    show('hold', fill, dark);
    if (!best) return;
    if (steadySince && now - steadySince >= PAUSE_MS) take('steady');
    else if (now - arrived >= ROUGH_MS && bestSharp >= 0.6 * typicalSharp()) take('rough');
  }

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
    const c = best, lg = log, seq = taken++, at = Date.now() - opened;
    const travel = +Math.max(Math.abs(moved.x) / small.width, Math.abs(moved.y) / (small.height || 1)).toFixed(2);
    if (how !== 'extra') extra = { at: Date.now() + EXTRA_MS, until: Date.now() + EXTRA_UNTIL, sharp: bestSharp };
    const meta = { how, extra: how === 'extra', sharp: Math.round(bestSharp), speed: +speed.toFixed(2), travel, lost,
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
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      if (rec) { rec.encMs = Math.round(performance.now() - t0); rec.kb = Math.round(blob.size / 1024); }
      panel.querySelector('.burst-thumbs')?.insertAdjacentHTML('afterbegin', `<img src="${esc(URL.createObjectURL(blob))}" alt="">`);
      const id = await enqueue('/api/captures', fields, { photo: blob }, 'capture', { session: lg?.id });
      lg?.upload(id, 'capture');
      ids.push(id);
    }).catch((err) => console.warn('photo not saved', err));
  }

  const onHidden = () => { if (document.visibilityState === 'hidden' && stream) stop('hidden'); };

  // how: true = ✕ or Done; 'hidden' = screen off or another app; false = the screen is
  // closed. The log goes first (a hidden page may be frozen at any await), then the
  // photos still being saved, then the "n photos" note to the server.
  async function stop(how = true) {
    const running = !!stream, n = taken, id = sid;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHidden);
    removeEventListener('devicemotion', onMotion);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    best = null; spare = null;
    log?.end(how === true ? 'done' : how || 'left');
    log = null;
    if (!running) return;
    if (how === true && n) panel.innerHTML = `<p class="shot-done"><span class="spinner"></span> ${t('capture.saving')}</p>`;
    await saving;
    let end = null;
    if (n) end = await enqueue(`/api/captures/${id}/end`, { ...request(), n }, {}, 'capture-end', { keepFailed: false }).catch(() => null);
    kick();
    if (how === false) return;
    panel.hidden = !n;
    panel.innerHTML = n ? `${how === 'hidden' ? `<p class="shot-done">${t('burst.closed_hidden')}</p>` : ''}
      <p class="shot-done shot-progress"></p><p class="shot-done">${t('capture.sent', { n })} <a href="/queue">${t('capture.queue')}</a></p>` : '';
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
