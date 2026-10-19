import { api } from './api.js';
import { enqueue } from './queue.js';
import { scanImage, detectFrame } from './scanner.js';
import { esc, shrinkImage } from './ui.js';
import { t, lang } from './i18n.js';

// Photographing books one after another with the live camera: the front cover, turn the
// book over, the back cover, next book. The picture is taken by itself once the camera
// holds still on a sharp picture (a button takes it at once). Both pictures are then
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
  let prev = null, steady = 0, moved = true, best = 0, since = 0;
  let refresh = () => {};

  const say = () => {
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
    prev = null; steady = 0; moved = true; best = 0;
    front = null; back = null; reviewing = false; liveCode = null; hunting = false;
    panel.hidden = false;
    panel.innerHTML = `${intro ? `<p class="shot-intro">${intro}</p>` : ''}
      <div class="shot-live"><video muted playsinline></video><div class="shot-guide"></div><div class="shot-flash"></div>
        <div class="shot-meter"><i></i></div><p class="shot-hint" hidden></p>
        <button class="shot-torch" data-shots="torch" hidden aria-label="${t('shots.torch')}">🔦</button></div>
      <p class="shot-say"></p>
      <div class="shot-review" hidden></div>
      <p class="row"><button class="btn primary" data-shots="snap">📸 ${t('shots.snap')}</button>
        <button class="btn" data-shots="skip" hidden>${t('shots.skip')}</button>
        <button class="btn" data-shots="nocode" hidden>${t('shots.no_code')}</button>
        <button class="btn" data-shots="end">${t('shots.end')}</button></p>
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
    since = Date.now();
    timer = setInterval(tick, 120);
  }

  // Still and sharp? Movement = mean change of a small grey copy between ticks;
  // sharpness = variance of its Laplacian (text and edges in focus score high).
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
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
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
    best = Math.max(best * 0.98, sharp);
    if (diff > 10) { moved = true; steady = 0; } else if (diff < 3.5) steady++; else steady = Math.max(0, steady - 1);
    // After a photo, the book has to move (turned over, or the next one) before the next.
    const ready = !hint && moved && Date.now() - since > 1200 && sharp > 15 && sharp >= 0.7 * best;
    panel.querySelector('.shot-meter i').style.width = `${ready ? Math.min(100, (steady / 8) * 100) : 0}%`;
    if (ready && steady >= 8) snap();
  }

  async function snap() {
    if (busy || reviewing || !video?.videoWidth) return;
    busy = true;
    const blob = await still();
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(40);
    moved = false; steady = 0; since = Date.now();
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
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  }

  let torch = false;
  async function toggleTorch() {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    torch = !torch;
    await track.applyConstraints({ advanced: [{ torch }] }).catch(() => { torch = false; });
    panel.querySelector('.shot-torch')?.classList.toggle('on', torch);
  }

  // Front, then back, then both are shown; a side taken again goes back to the review.
  function took(blob) {
    if (side === 'front') front = blob; else back = blob;
    if (side === 'front' && !session.only && !back) side = 'back';
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
  }

  function keep() {
    save(session.only === 'back' ? null : front, session.only === 'front' ? null : back, liveCode);
    lastCode = liveCode ?? lastCode;
    front = null; back = null; reviewing = false; side = 'front'; liveCode = null;
    if (session.single) return stop();
    moved = false; since = Date.now();
    refresh();
    center(panel.querySelector('.shot-live'));
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
    panel.innerHTML = `<p class="shot-say"></p><div class="shot-review" hidden></div><p class="row"><span class="shot-cam"></span>
      <button class="btn" data-shots="skip" hidden>${t('shots.skip')}</button><button class="btn" data-shots="end">${t('shots.end')}</button></p>
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
    else if (act === 'snap') snap();
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
