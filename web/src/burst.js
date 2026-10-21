import { esc, shrinkImage } from './ui.js';
import { t } from './i18n.js';

// Shelf photos taken by themselves: the reader moves the phone along the shelves and
// stops for a moment at each group of spines. The camera is looked at about 7 times a
// second (a tiny grey copy: cheap), and while it holds still the sharpest frame of that
// pause is kept, full size. Then nothing more is kept until the camera points somewhere
// else (the picture differs enough from the last one kept), so a long pause gives one
// photo, not ten, and frames taken while moving (blurred) are never sent. Every BATCH
// photos go to onBatch(blobs) as one scan, in the background (its photos are read
// together, so a spine seen in two of them counts once); the rest when the reader stops.
// onBatch resolves to a line to show. Without a live camera, start() returns false.
const TICK_MS = 150;
const BATCH = 8;
const STILL = 8;        // mean grey change between ticks: held still (by hand: 3–10; moving: 20+)
const ELSEWHERE = 12;   // mean grey change from the last photo: a different part of the shelf
const PAUSE_MS = 450;   // still this long: the photo is taken (the sharpest frame so far)
const MIN_SHARP = 8;

export function burstShots({ panel, onBatch, onEnd }) {
  let stream = null, video = null, timer = null;
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, last = null, stillSince = 0, settleUntil = 0;
  let best = null, bestScore = 0, spare = null;
  let batch = [], taken = 0, saving = Promise.resolve();

  async function start() {
    stop(false);
    panel.hidden = false;
    panel.innerHTML = `<h2 class="shot-title">${t('burst.title')}</h2>
      <div class="shot-live burst"><video muted playsinline></video><div class="shot-flash"></div>
        <p class="shot-hint" hidden></p><span class="burst-count">0</span>
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
    prev = null; last = null; stillSince = 0; dropBest();
    settleUntil = Date.now() + 700; // exposure and focus settle
    timer = setInterval(tick, TICK_MS);
    return true;
  }

  // Movement = mean change of the tiny grey copy; sharpness = variance of its Laplacian.
  function tick() {
    if (!video?.videoWidth) return;
    const w = 160, h = Math.round((w * video.videoHeight) / video.videoWidth);
    small.width = w; small.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    let bright = 0;
    for (let i = 0; i < g.length; i++) { g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; bright += g[i]; }
    const diff = (a) => { if (a?.length !== g.length) return 99; let d = 0; for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - a[i]); return d / g.length; };
    const moving = diff(prev);
    prev = g;
    const hintEl = panel.querySelector('.shot-hint');
    const dark = bright / g.length < 55;
    hintEl.hidden = !dark && moving < 35;
    if (!hintEl.hidden) hintEl.textContent = t(dark ? 'shots.dark' : 'burst.slower');
    // Still pointing at what was just photographed: wait for the next part.
    if (Date.now() < settleUntil || (last && diff(last) < ELSEWHERE)) { stillSince = 0; dropBest(); return; }
    if (moving > STILL) {
      // The pause ended before PAUSE_MS: its best frame is still worth keeping.
      if (best && moving > 2 * STILL) take();
      stillSince = 0; dropBest();
      return;
    }
    let sum = 0, sq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sq += l * l; n++;
    }
    const sharp = sq / n - (sum / n) ** 2;
    stillSince ||= Date.now();
    const score = sharp / (1 + moving / 4); // sharp, and of the stillest moment
    if (sharp > MIN_SHARP && score > bestScore) keepBest(score, g);
    if (best && Date.now() - stillSince >= PAUSE_MS) take();
  }

  function keepBest(score, g) {
    const c = spare ?? document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    spare = best; best = c; best.grey = g; bestScore = score;
  }
  function dropBest() {
    if (best) spare = best;
    best = null; bestScore = 0;
  }

  function take() {
    const c = best;
    last = c.grey;
    best = null; bestScore = 0; stillSince = 0;
    spare = null; // c is handed over; a new canvas next time
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(30);
    panel.querySelector('.burst-count').textContent = ++taken;
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
    const li = document.createElement('li');
    li.innerHTML = `<span class="spinner"></span> ${esc(t('add3.photos_n', { n: blobs.length }))}`;
    panel.querySelector('.shot-done')?.prepend(li);
    onBatch(blobs).then((line) => { li.innerHTML = line; }, (err) => { li.textContent = `⚠️ ${err.message}`; });
  }

  // done: send what is left and close the camera; the lines of what was sent stay.
  async function stop(done = true) {
    clearInterval(timer);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
    best = null; spare = null;
    if (!done) return;
    await saving; // the last photo may still be being shrunk
    send();
    const sent = panel.querySelector('.shot-done');
    panel.innerHTML = '';
    if (sent?.children.length) panel.append(sent); else panel.hidden = true;
    taken = 0;
    onEnd?.();
  }

  panel.addEventListener('click', (e) => { if (e.target.closest('[data-burst="end"]')) stop(); });
  return { start, stop, available: !!navigator.mediaDevices?.getUserMedia };
}
