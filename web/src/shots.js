import { api } from './api.js';
import { enqueue } from './queue.js';
import { scanImage, detectFrame } from './scanner.js';
import { esc, shrinkImage } from './ui.js';
import { t, lang } from './i18n.js';

// Photographing books one after another with the live camera: the front cover, turn the
// book over, the back cover, next book. The picture is taken by itself the moment the
// camera holds still on a sharp picture, or else the sharpest of the frames seen while
// the book was held roughly still for a moment (a button takes it at once); a short animation
// then shows turning the book over, or the next book coming. Both pictures are then
// shown, to keep or to take one side again. Each book is handed to
// onBook({ front, back, isbn }) in the background, which resolves to a line to show.
// While the camera is on, it also looks for the barcode: a whole back cover in one
// photo leaves the barcode too small to decode from the still, but the live picture,
// read many times a second, usually catches it. If it has not by the time the back
// cover is taken, the reader is asked for a close-up of the barcode for a few seconds.
// Without a live camera, the phone's camera app is used instead, one photo at a time.
export function bookShots({ on, panel, onBook, onStart, onEnd }) {
  let stream = null, video = null, timer = null, side = 'front', front = null, back = null, preset = null, busy = false;
  let reviewing = false;
  let liveCode = null, lastCode = null, looking = false, ticks = 0;
  let hunting = false, huntUntil = 0; // after the back cover: a few seconds for a close-up of the barcode
  let session = {}; // this time only: { intro, single, onBook }
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, steady = 0, moved = true, since = 0, lastSharp = 0;
  // The sharpest full-size frame so far while the book is held roughly still, and since when.
  let best = null, bestScore = 0, spare = null, window0 = 0;
  const BEST_MS = 1200;
  let refresh = () => {};

  const title = (k) => { const el = panel.querySelector('.shot-title'); if (el) el.textContent = k ? t(k) : ''; };
  const say = () => {
    title(reviewing ? null : hunting ? 'shots.title_code' : side === 'front' ? 'shots.title_front' : 'shots.title_back');
    const live = panel.querySelector('.shot-live');
    if (live) live.hidden = reviewing;
    panel.querySelector('.shot-cam')?.toggleAttribute('hidden', reviewing);
    panel.querySelector('[data-shots="snap"]')?.toggleAttribute('hidden', reviewing || hunting);
    panel.querySelector('[data-shots="nocode"]')?.toggleAttribute('hidden', !hunting);
    const rev = panel.querySelector('.shot-review');
    rev.hidden = !reviewing;
    if (reviewing) {
      panel.querySelector('.shot-say').innerHTML = `<b>${t('shots.review')}</b>`;
      panel.querySelector('[data-shots="skip"]').hidden = true;
      const sides = session.only ? [session.only] : ['front', 'back'];
      rev.innerHTML = `<div class="shot-pair">${sides.map((s) => {
        const blob = s === 'front' ? front : back;
        return `<figure>${blob ? `<img src="${esc(URL.createObjectURL(blob))}" alt="">` : `<div class="shot-none">${t('shots.no_back_yet')}</div>`}
          <figcaption><button class="btn small" data-shots="again-${s}">📷 ${t(blob ? `shots.again_${s}` : 'shots.back')}</button></figcaption></figure>`;
      }).join('')}</div>
        <p class="row"><button class="btn primary" data-shots="ok">✓ ${t(session.single ? 'shots.ok_single' : 'shots.ok')}</button></p>`;
      center(rev);
      return;
    }
    if (hunting) {
      panel.querySelector('.shot-say').innerHTML = `<b>${t('shots.code_close')}</b><br><span class="muted small">${t('shots.code_close_how')}</span>`;
      panel.querySelector('[data-shots="skip"]').hidden = true;
      return;
    }
    panel.querySelector('.shot-say').innerHTML = side === 'front'
      ? `<b>${t('shots.front_now')}</b><br><span class="muted small">${t('shots.front_how')}</span>`
      : `<b>${t('shots.now_back')}</b><br><span class="muted small">${t('shots.back_why')}</span>`;
    panel.querySelector('[data-shots="skip"]').hidden = side !== 'back' || !!session.only || !!back;
    showCode();
  };
  const showCode = () => {
    const say = panel.querySelector('.shot-say');
    if (liveCode && say && !reviewing && !say.querySelector('.code-seen')) say.insertAdjacentHTML('beforeend', `<br><span class="ok small code-seen">${t('shots.code_seen')}</span>`);
  };
  // Every few ticks, in the background: the detector is slower than a tick.
  async function lookForCode() {
    if (looking || liveCode || preset || !video?.videoWidth) return;
    looking = true;
    const code = await detectFrame(video).catch(() => null);
    looking = false;
    // The book just saved may still be in view: its code is not the next book's.
    if (code && code !== lastCode && !liveCode && !reviewing) { liveCode = code; navigator.vibrate?.(30); showCode(); }
  }
  // The camera (or the review) in the middle of the screen.
  const center = (el) => requestAnimationFrame(() => el?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  const thumb = (blob) => `<img class="shot-thumb" src="${esc(URL.createObjectURL(blob))}" alt="">`;

  // only: 'front' or 'back' = one picture of that side (a new or missing one).
  async function start({ isbn = null, intro = null, single = false, only = null, onBook: own = null } = {}) {
    stopCamera();
    preset = isbn;
    session = { intro, single: single || !!only, only, onBook: own };
    refresh = say;
    side = only ?? 'front';
    prev = null; steady = 0; moved = true; dropBest();
    front = null; back = null; reviewing = false; liveCode = null; hunting = false;
    panel.hidden = false;
    panel.innerHTML = `${intro ? `<p class="shot-intro">${intro}</p>` : ''}
      <h2 class="shot-title"></h2>
      <div class="shot-live"><video muted playsinline></video><div class="shot-guide"></div><div class="shot-flash"></div>
        <div class="shot-anim" hidden></div><p class="shot-hint" hidden></p>
        <button class="shot-x" data-shots="end" aria-label="${t('shots.stop')}">✕</button>
        <button class="shot-torch" data-shots="torch" hidden aria-label="${t('shots.torch')}">🔦</button></div>
      <p class="shot-say"></p>
      <div class="shot-review" hidden></div>
      <p class="row"><button class="btn primary" data-shots="snap">📸 ${t('shots.snap')}</button>
        <button class="btn" data-shots="skip" hidden>${t('shots.skip')}</button>
        <button class="btn" data-shots="nocode" hidden>${t('shots.no_code')}</button></p>
      <button class="btn shot-stop" data-shots="end">■ ${t('shots.stop')}</button>
      <ul class="shot-done"></ul>`;
    video = panel.querySelector('video');
    center(panel.querySelector('.shot-live'));
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } } });
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      if (track.getCapabilities?.().torch) panel.querySelector('.shot-torch').hidden = false;
    } catch {
      stopCamera();
      return fallback();
    }
    say();
    center(panel.querySelector('.shot-live'));
    since = Date.now() + 600; // the camera settles its exposure and focus
    timer = setInterval(tick, 120);
  }

  // Still and sharp? Movement = mean change of a small grey copy between ticks;
  // sharpness = variance of its Laplacian (text and edges in focus score high).
  // Sharpness is measured inside the guide frame, where the cover is, so a sharp table
  // around a small, far-away book does not count. Two still ticks in a row (a quarter of
  // a second) are enough; meanwhile, every frame that is roughly still is a candidate,
  // and a moment after the first one the sharpest of them is taken — shaking hands,
  // a white cover read as a reflection or a camera that keeps refocusing then no
  // longer hold up the photo.
  function tick() {
    if (hunting) {
      lookForCode();
      if (liveCode || Date.now() > huntUntil) endHunt();
      return;
    }
    if (busy || reviewing || !video.videoWidth) return;
    if (++ticks % 4 === 0) lookForCode();
    const w = 160, h = Math.round((w * video.videoHeight) / video.videoWidth);
    small.width = w; small.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    let diff = 99;
    if (prev?.length === g.length) { diff = 0; for (let i = 0; i < g.length; i++) diff += Math.abs(g[i] - prev[i]); diff /= g.length; }
    prev = g;
    let sum = 0, sq = 0, n = 0;
    const x0 = Math.round(w * 0.12), x1 = w - x0, y0 = Math.round(h * 0.08), y1 = h - y0;
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
        const i = y * w + x;
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += l; sq += l * l; n++;
      }
    }
    const sharp = sq / n - (sum / n) ** 2;
    // A reflection (a patch of burnt-out white) or too little light spoils the small print.
    let bright = 0, burnt = 0;
    for (let i = 0; i < g.length; i++) { bright += g[i]; if (g[i] > 250) burnt++; }
    const hint = burnt / g.length > 0.03 ? 'shots.glare' : bright / g.length < 60 ? 'shots.dark' : null;
    const hintEl = panel.querySelector('.shot-hint');
    hintEl.hidden = !hint;
    if (hint) hintEl.textContent = t(hint);
    // A big change = a different picture: the frames kept so far are no longer of it.
    if (diff > 10) { moved = true; steady = 0; dropBest(); } else if (diff < 3.5) steady++; else steady = 0;
    // After a photo, the book has to move (turned over, or the next one) before the next.
    // Not while the camera is still focusing (sharpness still changing from tick to tick).
    const focused = Math.abs(sharp - lastSharp) <= 0.15 * Math.max(sharp, lastSharp);
    lastSharp = sharp;
    if (!moved || Date.now() <= since) { dropBest(); return; }
    if (!hint && sharp > 15 && focused && steady >= 2) { snap(true); return; }
    if (diff < 8 && sharp > 8) {
      const score = sharp * (1 - Math.min(0.5, (5 * burnt) / g.length)) * (focused ? 1 : 0.8);
      if (score > bestScore) keepBest(score);
      window0 ||= Date.now();
    }
    if (best && Date.now() - window0 >= BEST_MS) snap(true, best);
  }

  // The frame now, full size, as the best candidate (two canvases, swapped, no copying).
  function keepBest(score) {
    const c = spare ?? document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    spare = best; best = c; bestScore = score;
  }
  function dropBest() {
    if (best) spare = best;
    best = null; bestScore = 0; window0 = 0;
  }

  // auto: the frame on screen right now, or the given one (instant). The button asks the
  // camera for a full photo, which can take a moment to focus.
  async function snap(auto = false, from = null) {
    if (busy || reviewing || !video?.videoWidth) return;
    busy = true;
    const blob = from ? await toJpeg(from) : auto ? await frame() : await still();
    dropBest();
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(40);
    moved = false; steady = 0; since = Date.now() + 300;
    took(blob);
    busy = false;
  }

  // A real photo where the browser can take one (sharper and less noisy than a frame
  // of the video), else the current frame of the video.
  async function still() {
    const track = stream?.getVideoTracks()[0];
    if (track && 'ImageCapture' in window) {
      try {
        const photo = await new ImageCapture(track).takePhoto();
        if (photo?.size) return photo;
      } catch { /* not supported by this camera: the video frame below */ }
    }
    return frame();
  }
  function frame() {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return toJpeg(c);
  }
  const toJpeg = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));

  let torch = false;
  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    torch = !torch;
    await track.applyConstraints({ advanced: [{ torch }] }).catch(() => { torch = false; });
    panel.querySelector('.shot-torch')?.classList.toggle('on', torch);
  }

  // Over the camera for a moment: the book turning over, or the next book coming in.
  // No photo is taken meanwhile.
  function animate(kind) {
    const el = panel.querySelector('.shot-anim');
    if (!el || !stream) return;
    el.className = `shot-anim ${kind}`;
    el.innerHTML = kind === 'turn'
      ? `<div class="anim-book"><i class="face front"></i><i class="face back"><b></b></i></div><p>↻ ${t('shots.anim_turn')}</p>`
      : `<div class="anim-book out"><i class="face front"></i></div><div class="anim-book in"><i class="face front"></i></div><p>📕 ${t('shots.anim_next')}</p>`;
    el.hidden = false;
    since = Math.max(since, Date.now() + 1100);
    clearTimeout(animate.timer);
    animate.timer = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, 1100);
  }

  // Front, then back, then both are shown; a side taken again goes back to the review.
  function took(blob) {
    if (side === 'front') front = blob; else back = blob;
    if (side === 'front' && !session.only && !back) { side = 'back'; animate('turn'); }
    else if (side === 'back' && stream && !liveCode && !preset) { hunting = true; huntUntil = Date.now() + 6000; }
    else reviewing = true;
    refresh();
  }
  function endHunt() {
    hunting = false;
    reviewing = true;
    refresh();
  }

  function again(s) {
    reviewing = false; side = s;
    moved = true; steady = 0; since = Date.now() + 800; // time to turn the book
    refresh();
    center(panel.querySelector('.shot-live'));
    if (s === 'front') animate('turn');
  }

  function keep() {
    save(session.only === 'back' ? null : front, session.only === 'front' ? null : back, liveCode);
    lastCode = liveCode ?? lastCode;
    front = null; back = null; reviewing = false; side = 'front'; liveCode = null;
    if (session.single) return stop();
    moved = false; since = Date.now();
    refresh();
    center(panel.querySelector('.shot-live'));
    animate('next');
  }

  // In the background, so the next book can be photographed meanwhile.
  async function save(f, b, seen = null) {
    const handle = session.onBook ?? onBook;
    const isbn = preset || seen || (b && await scanImage(b).catch(() => null)) || (f && await scanImage(f).catch(() => null));
    preset = null;
    const li = document.createElement('li');
    li.innerHTML = `${f ? thumb(f) : ''}${b ? thumb(b) : ''}<span><span class="spinner"></span></span>`;
    panel.querySelector('.shot-done')?.prepend(li);
    let line;
    try {
      line = await handle({ front: f && await shrinkImage(f, 2400), back: b ? await shrinkImage(b, 2400) : null, isbn });
    } catch (err) { line = `⚠️ ${esc(err.message)}`; }
    li.lastElementChild.innerHTML = line;
  }

  // No live camera: the camera app, one photo at a time.
  function fallback() {
    const cam = (s, label) => `<label class="btn primary">📷 ${label}<input type="file" accept="image/*" capture="environment" hidden data-side="${s}"></label>`;
    panel.innerHTML = `<h2 class="shot-title"></h2><p class="shot-say"></p><div class="shot-review" hidden></div><p class="row"><span class="shot-cam"></span>
      <button class="btn" data-shots="skip" hidden>${t('shots.skip')}</button></p>
      <button class="btn shot-stop" data-shots="end">■ ${t('shots.stop')}</button>
      <ul class="shot-done"></ul>`;
    const show = () => { panel.querySelector('.shot-cam').innerHTML = cam(side, t(side === 'front' ? 'shots.front_btn' : 'shots.back')); say(); };
    refresh = show;
    panel.onchange = (e) => {
      const file = e.target.closest('input[data-side]')?.files[0];
      if (file) took(file);
    };
    show();
  }

  function stopCamera() {
    clearInterval(timer);
    torch = false;
    best = null; spare = null; bestScore = 0; window0 = 0;
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }
  function stop() {
    stopCamera();
    panel.hidden = true;
    panel.innerHTML = '';
    panel.onchange = null;
    onEnd?.();
  }

  on.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shots]');
    if (!b) return;
    const act = b.dataset.shots;
    if (act === 'start') { onStart?.(); start(); }
    else if (act === 'snap') snap(false);
    else if (act === 'torch') toggleTorch();
    else if (act === 'end') stop();
    else if (act === 'skip' && front) { reviewing = true; refresh(); }
    else if (act === 'nocode') endHunt();
    else if (act === 'ok') keep();
    else if (act.startsWith('again-')) again(act.slice(6));
  });
  panel.hidden = true;
  return { start, stop };
}

// A book no catalogue knows (or with no barcode read): its covers go to the server,
// which reads them; the book then waits in the approval queue.
export async function sendCovers({ code = null, kind = 'seen', pos = null, isbn = null, front, back, owner = null, friend_name: friend = null, replaces = null }) {
  const fields = { code, kind, isbn, owner, friend_name: friend, replaces, lang: lang(), lat: pos?.lat ?? '', lon: pos?.lon ?? '' };
  const files = { photo: front, back };
  try {
    if (!navigator.onLine) throw new TypeError('offline');
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => v != null && fd.append(k, v));
    Object.entries(files).forEach(([k, b]) => b && fd.append(k, b, `${k}.jpg`));
    await api('/api/covers', { method: 'POST', form: fd });
    return `📤 ${t('shots.reading_later')}`;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    await enqueue('/api/covers', fields, files, 'book');
    return `💾 ${t('bc.saved_offline')}`;
  }
}
