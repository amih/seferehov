import { enqueue, append, release, discard, removeFiles } from './queue.js';
import { trackLine } from './outbox-ui.js';
import { scanImage, detectFrame } from './scanner.js';
import { esc, shrinkImage } from './ui.js';
import { loadBookModel } from './bookai.js';
import { t, lang } from './i18n.js';

// Photographing books one after another with the live camera: the front cover, turn the
// book over, the back cover, next book. The picture is taken by itself the moment the
// camera holds still on a sharp picture, or else the sharpest of the frames seen while
// the book was held roughly still for a moment (a button takes it at once); a short animation
// then shows turning the book over, or the next book coming. Store and forward
// (queue.js): each picture is saved on the phone the moment it is taken, and the book
// is sent by itself once its back is taken (or "no back", or the camera closes for any
// reason: ✕, the screen going off, another app, leaving the screen). Nothing waits for a
// button: for RETAKE_MS after a book the camera shows its two pictures with "retake" on
// each (the first take is sometimes too quick); untouched, or once the next book's front
// is taken, the book goes. A wrong book is declined later in the approval queue. target({ isbn }) gives
// the address and fields to send the book to; sent(answer) the line to show once sent.
// While the camera is on, it also looks for the barcode: a whole back cover in one
// photo leaves the barcode too small to decode from the still, but the live picture,
// read many times a second, usually catches it. If it has not by the time the back
// cover is taken, the reader is asked for a close-up of the barcode for a few seconds.
// Without a live camera, the phone's camera app is used instead, one photo at a time.
// Many books at once (stack): the books lie in a row, all the front covers are taken one
// after another, then every book is turned over in place and the backs are taken in the
// same order; each book is sent as soon as its back is taken. Here a photo is taken
// only when the camera has paused on a book (bookai.js), so aiming at the first book,
// moving between books or pointing away after the last one takes nothing; a wrong photo
// can still be removed from the strip. The switch to the backs is noticed by itself: after
// the fronts, a long while with no book in view (the books being turned over), then books
// again — these are taken as the backs, with a banner saying so and a button to undo.
export function bookShots({ on, panel, target, sent, onStart, onEnd }) {
  let stream = null, video = null, timer = null, side = 'front', front = null, back = null, preset = null, busy = false;
  let liveCode = null, lastCode = null, looking = false, ticks = 0;
  let hunting = false, huntUntil = 0; // after the back cover: a few seconds for a close-up of the barcode
  let session = {}; // this time only: { intro, single, only, target, sent, stack }
  let stack = null; // many books: { phase: fronts|backs, fronts, ids, backs, codes, frontAt, bookAt, away, auto }
  let held = null;  // one book: the outbox id (a promise) of its pictures so far
  let last = null;  // the book just taken, during its retake time: { id, f, b, code, timer }
  const RETAKE_MS = 6000;
  let storing = Promise.resolve();
  let isBook = null; // the book detector, once loaded (null: loading, or this phone cannot run it)
  let noBookSince = 0;
  // A pause over a book, hand-held: from tick to tick the picture changes by less than
  // PAUSE_DIFF (moving between books it changes by 15–45, a hand pausing by 4–10;
  // smoothed, so one jolt does not end a pause), for PAUSE_MS; without the detector, for
  // NO_MODEL_MS. The detector's answer counts while no older than ANSWER_MS.
  const PAUSE_DIFF = 12, PAUSE_MS = 500, NO_MODEL_MS = 1200, ANSWER_MS = 600, AWAY_MIN_MS = 5000;
  let pausedSince = 0, motion = 99;
  const small = document.createElement('canvas');
  const ctx = small.getContext('2d', { willReadFrequently: true });
  let prev = null, steady = 0, moved = true, since = 0, lastSharp = 0;
  // The sharpest full-size frame so far while the book is held roughly still, and since when.
  let best = null, bestScore = 0, spare = null, window0 = 0;
  const BEST_MS = 800;
  let peak = 0, shotGrey = null, ready = 0; // ready: since when a photo may be taken // the recent sharpest (decays): sharp is judged against it, not a fixed number
  let refresh = () => {};

  const title = (k) => { const el = panel.querySelector('.shot-title'); if (el) el.textContent = k ? t(k) : ''; };
  const say = () => {
    if (stack) return sayStack();
    title(hunting ? 'shots.title_code' : side === 'front' ? 'shots.title_front' : 'shots.title_back');
    panel.querySelector('[data-shots="snap"]')?.toggleAttribute('hidden', hunting);
    panel.querySelector('[data-shots="nocode"]')?.toggleAttribute('hidden', !hunting);
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
  // Many books: what to photograph now, the book whose back is wanted, and the pairs at the end.
  const sayStack = () => {
    const { phase, fronts, backs } = stack;
    const el = panel.querySelector('.shot-title');
    if (el) el.textContent = phase === 'fronts' ? t(stack.away ? 'stack.title_away' : 'stack.title_front', { n: fronts.length + 1 }) : t('stack.title_back', { n: backs.length + 1, total: fronts.length });
    panel.querySelector('[data-shots="skip"]').hidden = phase !== 'backs';
    panel.querySelector('[data-shots="stack-backs"]').hidden = phase !== 'fronts' || !fronts.length;
    const match = panel.querySelector('.shot-match');
    match.hidden = phase !== 'backs';
    if (phase === 'backs') match.src = URL.createObjectURL(fronts[backs.length]);
    panel.querySelector('.shot-say').innerHTML = phase === 'fronts'
      ? `<b>${t('stack.fronts_now')}</b><br><span class="muted small">${t('stack.fronts_how')}</span>${fronts.length ? `<span class="stack-strip">${fronts.map((f, i) => `<span class="strip-item">${thumb(f)}<button class="strip-x" data-shots="drop-${i}" aria-label="${esc(t('stack.drop'))}">✕</button></span>`).join('')}</span>` : ''}`
      : `${stack.auto ? `<span class="auto-backs">🔄 <b>${t('stack.auto_backs')}</b> <button class="btn small" data-shots="still-fronts">${t('stack.still_fronts')}</button></span><br>` : ''}<b>${t('stack.backs_now')}</b><br><span class="muted small">${t('stack.backs_how')}</span>`;
    if (phase === 'fronts' && stack.away) panel.querySelector('.shot-say').insertAdjacentHTML('afterbegin', `<span class="auto-backs">🔄 ${t('stack.away')}</span><br>`);
    const banner = panel.querySelector('.stack-banner');
    banner.hidden = !(phase === 'backs' && stack.auto) && !(phase === 'fronts' && stack.away);
    banner.textContent = phase === 'backs' ? `🔄 ${t('stack.banner_backs')}` : `🔄 ${t('stack.banner_away')}`;
    if (phase === 'backs') showCode();
  };
  const showCode = () => {
    const say = panel.querySelector('.shot-say');
    if (liveCode && say && !say.querySelector('.code-seen')) say.insertAdjacentHTML('beforeend', `<br><span class="ok small code-seen">${t('shots.code_seen')}</span>`);
  };
  // Every few ticks, in the background: the detector is slower than a tick.
  async function lookForCode() {
    if (looking || liveCode || preset || !video?.videoWidth) return;
    looking = true;
    const code = await detectFrame(video).catch(() => null);
    looking = false;
    // The book just saved may still be in view: its code is not the next book's.
    if (code && code !== lastCode && !liveCode) { liveCode = code; navigator.vibrate?.(30); showCode(); }
  }
  // The camera (or the review) in the middle of the screen.
  const center = (el) => requestAnimationFrame(() => el?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  const thumb = (blob) => `<img class="shot-thumb" src="${esc(URL.createObjectURL(blob))}" alt="">`;

  // only: 'front' or 'back' = one picture of that side (a new or missing one).
  async function start({ isbn = null, intro = null, single = false, only = null, target: to = null, sent: done = null, many = false, go = false } = {}) {
    await finish();
    stopCamera();
    if (many && !go) return comic();
    preset = isbn;
    session = { intro, single: single || !!only, only, target: to ?? target, sent: done ?? sent, stack: many };
    stack = many ? newStack() : null;
    pausedSince = 0; noBookSince = 0; motion = 99;
    if (many) loadBookModel().then((d) => { isBook = d; });
    refresh = say;
    side = only ?? 'front';
    prev = null; steady = 0; moved = true; dropBest();
    front = null; back = null; held = null; liveCode = null; hunting = false;
    panel.hidden = false;
    panel.innerHTML = `${intro ? `<p class="shot-intro">${intro}</p>` : ''}
      <h2 class="shot-title"></h2>
      <div class="shot-live"><video muted playsinline></video><div class="shot-guide"></div><div class="shot-flash"></div>
        <img class="shot-match" alt="" hidden><p class="stack-banner" hidden></p>
        <div class="shot-anim" hidden></div><p class="shot-hint" hidden></p>
        <button class="shot-x" data-shots="end" aria-label="${t('shots.stop')}">✕</button>
        <button class="shot-torch" data-shots="torch" hidden aria-label="${t('shots.torch')}">🔦</button></div>
      <p class="shot-say"></p>
      <p class="row"><button class="btn primary" data-shots="snap">📸 ${t('shots.snap')}</button>
        <button class="btn" data-shots="skip" hidden>${t(many ? 'stack.no_back' : 'shots.skip')}</button>
        <button class="btn" data-shots="nocode" hidden>${t('shots.no_code')}</button>
        <button class="btn" data-shots="stack-backs" hidden>${t('stack.to_backs')}</button></p>
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
    document.addEventListener('visibilitychange', onHidden);
  }

  // Still and sharp? Movement = mean change of a small grey copy between ticks;
  // sharpness = variance of its Laplacian (text and edges in focus score high).
  // Sharpness is measured inside the guide frame, where the cover is, so a sharp table
  // around a small, far-away book does not count. Sharp enough = near the sharpest seen
  // lately (no fixed number: plain or square covers score low). Two still ticks in a row
  // (a quarter of a second) are enough; meanwhile, every frame that is roughly still is a candidate,
  // and a moment after the first one the sharpest of them is taken — shaking hands,
  // a white cover read as a reflection or a camera that keeps refocusing then no
  // longer hold up the photo.
  function tick() {
    if (hunting) {
      lookForCode();
      if (liveCode || Date.now() > huntUntil) endHunt();
      return;
    }
    if (busy || !video.videoWidth) return;
    if (++ticks % 4 === 0 && stack?.phase !== 'fronts') lookForCode();
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
    // Moved on since the last photo: the picture now differs from it (however slowly the
    // book was turned), and a sharpness peak of the last side no longer counts.
    if (!moved && shotGrey?.length === g.length) {
      let d = 0; for (let i = 0; i < g.length; i++) d += Math.abs(g[i] - shotGrey[i]);
      if (d / g.length > 15) { moved = true; peak = 0; }
    }
    peak = Math.max(sharp, peak * 0.97);
    // A big change = a different picture: the frames kept so far are no longer of it.
    // (A book held in one hand shakes by up to ~20; turning it over or the next book is far more.)
    if (diff > 35) { moved = true; steady = 0; dropBest(); } else if (diff < 5) steady++; else steady = 0;
    // After a photo, the book has to move (turned over, or the next one) before the next.
    // Not while the camera is still focusing (sharpness still changing from tick to tick).
    const focused = Math.abs(sharp - lastSharp) <= 0.15 * Math.max(sharp, lastSharp);
    lastSharp = sharp;
    if (!moved || Date.now() <= since) { dropBest(); ready = 0; return; }
    ready ||= Date.now();
    // Plain covers (one colour, little print) and small or square books leave less detail
    // in the frame: sharp enough = near the recent best, above a low floor.
    const sharpEnough = sharp > 5 && sharp >= 0.8 * peak;
    if (stack) { stackTick(diff, sharp, burnt / g.length, hint, hintEl); return; }
    if (!hint && sharpEnough && focused && steady >= 2) { snap(true); return; }
    // The longer the wait, the more shake a candidate may have (a hand that never quite
    // holds still still gets its photo within a second or two); the stillest win.
    const limit = Math.min(30, 10 + 12 * (Date.now() - ready) / 1000);
    if (diff < limit && sharp > 3) {
      const score = sharp / (1 + diff / 4) * (1 - Math.min(0.5, (5 * burnt) / g.length)) * (focused ? 1 : 0.8);
      if (score > bestScore) keepBest(score);
      window0 ||= Date.now();
    }
    if (best && Date.now() - window0 >= BEST_MS) snap(true, best);
  }

  // Many books: no photo while the camera moves. During a pause the detector is asked
  // about the picture (in the background, as often as it can answer); half a second into
  // a pause on a book, the sharpest frame of the pause is taken. Paused on no book for a
  // while: a hint says why. If the detector cannot run on this phone, a longer pause
  // takes the photo instead.
  function stackTick(diff, sharp, burnt, hint, hintEl) {
    const now = Date.now();
    // After the fronts: no book in view for much longer than the pace of the photos so
    // far — probably turning the books over.
    if (stack.phase === 'fronts' && stack.fronts.length >= 2 && !stack.away && now - stack.bookAt > awayMs()) { stack.away = true; refresh(); }
    motion = (motion + diff) / 2;
    if (motion >= PAUSE_DIFF) { pausedSince = 0; noBookSince = 0; dropBest(); return; }
    pausedSince ||= now;
    const score = (sharp / (1 + diff / 4)) * (1 - Math.min(0.5, 5 * burnt));
    if (sharp > 3 && score > bestScore) keepBest(score);
    if (!isBook) {
      if (!hint && now - pausedSince >= NO_MODEL_MS) { pausedSince = 0; snap(true, best); }
      return;
    }
    isBook.look(video);
    const seen = now - (isBook.latest?.at ?? 0) <= ANSWER_MS ? isBook.latest.p : null;
    if (window.shotDebug) console.log(`stack diff=${diff.toFixed(1)} paused=${now - pausedSince} book=${seen?.toFixed(2) ?? '-'} ms=${isBook.ms}`);
    if (seen === null) return;
    if (seen >= 0.5) {
      noBookSince = 0;
      if (stack.phase === 'fronts' && stack.away) autoBacks();
      stack.bookAt = now;
      if (!hint && now - pausedSince >= PAUSE_MS) { pausedSince = 0; snap(true, best); }
      return;
    }
    noBookSince ||= now;
    if (now - noBookSince > 2000 && hintEl.hidden) { hintEl.hidden = false; hintEl.textContent = t('stack.no_book'); }
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
    if (busy || !video?.videoWidth) return;
    busy = true;
    const blob = from ? await toJpeg(from) : auto ? await frame() : await still();
    dropBest();
    const flash = panel.querySelector('.shot-flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    navigator.vibrate?.(40);
    moved = false; steady = 0; since = Date.now() + 300; shotGrey = prev; peak = 0;
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
    el.innerHTML = kind === 'flipall'
      ? `<span class="cb-row">${[1, 2, 3].map((i) => `<span class="cb-book flip" style="--i:${i}"><i class="face front"></i><i class="face back"><b></b></i></span>`).join('')}</span><p>↻ ${t('stack.anim_flip')}</p>`
      : kind === 'turn'
      ? `<div class="anim-book"><i class="face front"></i><i class="face back"><b></b></i></div><p>↻ ${t('shots.anim_turn')}</p>`
      : `<div class="anim-book out"><i class="face front"></i></div><div class="anim-book in"><i class="face front"></i></div><p>📕 ${t('shots.anim_next')}</p>`;
    el.hidden = false;
    const ms = kind === 'flipall' ? 2600 : 1100;
    since = Math.max(since, Date.now() + ms);
    clearTimeout(animate.timer);
    animate.timer = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, ms);
  }

  // Front, then back (then a few seconds for the barcode), then the book is sent.
  function took(blob) {
    if (stack) return tookStack(blob);
    if (last) sendLast(); // the next book has begun: the last one is fine
    const name = side === 'front' ? 'photo' : 'back';
    if (side === 'front') front = blob; else back = blob;
    keepPicture(name, blob);
    if (side === 'front' && !session.only && !back) { side = 'back'; animate('turn'); }
    else if (side === 'back' && stream && !liveCode && !preset) { hunting = true; huntUntil = Date.now() + 4000; }
    else finishBook();
    refresh();
  }
  // Onto the phone at once (shrunk), into the book's held upload.
  function keepPicture(name, blob) {
    const was = held;
    held = storing = storing.then(async () => {
      const small = await shrinkImage(blob, 2400);
      const id = await was;
      if (id && await append(id, { [name]: small })) return id;
      const { url, fields, label } = session.target({ isbn: preset });
      return enqueue(url, fields, { [name]: small }, label ?? 'book', { hold: true });
    }).catch((err) => { console.warn('cover not saved', err); return null; });
  }
  // The book's pictures go, with the barcode if one was read (live, or from the stills).
  function finishBook() {
    hunting = false;
    if (!held) return;
    const id = held, f = front, b = back, code = preset || liveCode;
    lastCode = liveCode ?? lastCode;
    held = null; front = null; back = null; side = session.only ?? 'front'; liveCode = null; preset = null;
    last = { id, f, b, code, timer: setTimeout(() => { sendLast(); if (session.single) stop(); }, RETAKE_MS) };
    showLast();
    if (!session.single) { moved = false; since = Date.now(); animate('next'); }
    else since = Infinity; // one book only: nothing more to take, the camera waits for a retake
  }
  // The book just taken, over the camera: its pictures, each with "retake", and the time left.
  function showLast() {
    const box = panel.querySelector('.shot-live') ?? panel;
    box.querySelector('.shot-last')?.remove();
    if (!last) return;
    const sides = [['front', last.f], ['back', last.b]].filter(([, x]) => x);
    box.insertAdjacentHTML('beforeend', `<div class="shot-last"><span class="shot-last-ok">✓ ${t('shots.last_saved')}</span>
      <span class="shot-last-pics">${sides.map(([k, x]) => `<button data-shots="retake-${k}">${thumb(x)}<b>↻ ${t(`shots.again_${k}`)}</b></button>`).join('')}</span>
      <span class="shot-last-bar"><i style="animation-duration:${RETAKE_MS}ms"></i></span></div>`);
  }
  function sendLast() {
    if (!last) return;
    clearTimeout(last.timer);
    const { id, f, b, code } = last;
    last = null;
    showLast();
    sendBook(id, f, b, code);
  }
  // Retake one side of the book just taken: back to the camera for that side; then it is
  // shown again for its retake time.
  function retake(k) {
    if (!last) return;
    clearTimeout(last.timer);
    ({ id: held, f: front, b: back, code: liveCode } = last);
    last = null;
    showLast();
    hunting = false; side = k;
    moved = true; steady = 0; dropBest(); since = Date.now() + 800; // time to turn the book
    refresh();
    if (k === 'front' && back) animate('turn');
  }
  function sendBook(idPromise, f, b, code) {
    const li = document.createElement('li');
    panel.querySelector('.shot-done')?.prepend(li);
    const { target: to, sent: done } = session;
    storing = storing.then(async () => {
      const id = await idPromise;
      if (!id) return;
      const isbn = code || (b && await scanImage(b).catch(() => null)) || (f && await scanImage(f).catch(() => null));
      trackLine(li, id, { label: t('out.label_book'), before: `${f ? thumb(f) : ''}${b ? thumb(b) : ''}`, sent: (data) => done?.(data) ?? bookSentLine(data) });
      const { url, fields, alt } = to({ isbn });
      await release(id, { url, fields, alt });
    }).catch((err) => { li.textContent = `⚠️ ${err.message}`; });
  }
  // Many books: the next front, or the back of the next book in the row (null = none).
  function tookStack(blob) {
    if (stack.phase === 'fronts') {
      stack.fronts.push(blob);
      stack.ids.push(storeFront(blob));
      stack.frontAt.push(Date.now());
      stack.bookAt = Date.now();
      animate('next');
    } else {
      const i = stack.backs.length;
      stack.backs.push(blob);
      stack.codes.push(liveCode);
      if (blob) { const id = stack.ids[i]; storing = storing.then(async () => append(await id, { back: await shrinkImage(blob, 2400) })).catch(() => {}); }
      lastCode = liveCode ?? lastCode;
      liveCode = null;
      if (stack.backs.length >= stack.fronts.length) finishStack();
      else animate('next');
    }
    refresh();
  }
  function storeFront(blob) {
    const p = storing.then(async () => {
      const { url, fields, label } = session.target({ isbn: null });
      return enqueue(url, fields, { photo: await shrinkImage(blob, 2400) }, label ?? 'book', { hold: true });
    });
    storing = p.catch(() => {});
    return p;
  }
  // Every book of the row goes (those with no back yet with the front only).
  function finishStack() {
    if (!stack?.fronts.length) return;
    stack.fronts.forEach((f, i) => sendBook(stack.ids[i], f, stack.backs[i] ?? null, stack.codes[i] ?? null));
    stack = newStack();
    moved = false; since = Date.now();
    refresh();
  }
  const newStack = () => ({ phase: 'fronts', fronts: [], ids: [], backs: [], codes: [], frontAt: [], bookAt: Date.now(), away: false, auto: false });
  // How long without a book means "turning them over": 2.5 times the usual time between
  // two fronts, and at least 5 seconds.
  function awayMs() {
    const at = stack.frontAt, gaps = at.slice(1).map((x, i) => x - at[i]).sort((a, b) => a - b);
    return Math.max(AWAY_MIN_MS, 2.5 * (gaps[gaps.length >> 1] ?? 0));
  }
  // Books again after the long break: the backs, in the same order.
  function autoBacks() {
    Object.assign(stack, { phase: 'backs', backs: [], codes: [], away: false, auto: true });
    liveCode = null; lastCode = null;
    navigator.vibrate?.([40, 80, 40]);
    refresh();
  }
  // "No, still fronts": the photos taken as backs join the fronts.
  function stillFronts() {
    stack.backs.forEach((b, i) => {
      if (!b) return;
      const id = stack.ids[i];
      storing = storing.then(async () => removeFiles(await id, ['back'])).catch(() => {});
      stack.fronts.push(b);
      stack.ids.push(storeFront(b));
    });
    Object.assign(stack, { phase: 'fronts', backs: [], codes: [], auto: false, away: false, bookAt: Date.now() });
    refresh();
  }
  function toBacks() {
    Object.assign(stack, { phase: 'backs', backs: [], codes: [], away: false, auto: false });
    liveCode = null; lastCode = null;
    moved = true; steady = 0; dropBest();
    refresh();
    center(panel.querySelector('.shot-live'));
    animate('flipall');
  }
  // How the many-books mode works, as a small comic, before the camera opens.
  function comic() {
    panel.hidden = false;
    loadBookModel(); // while the comic is read
    const books = (cls = '') => `<span class="cb-row">${[1, 2, 3].map((i) => `<span class="cb-book ${cls}" style="--i:${i}"><i class="face front"></i><i class="face back"><b></b></i></span>`).join('')}</span>`;
    panel.innerHTML = `<h2 class="shot-title">${t('stack.title')}</h2>
      <ol class="comic">
        <li><div class="cb-pane">${books()}</div><p>${t('stack.c1')}</p></li>
        <li><div class="cb-pane">${books()}<span class="cb-phone"></span></div><p>${t('stack.c2')}</p></li>
        <li><div class="cb-pane flip">${books('flip')}</div><p>${t('stack.c3')}</p></li>
        <li><div class="cb-pane">${books('down')}<span class="cb-phone"></span></div><p>${t('stack.c4')}</p></li>
      </ol>
      <p class="muted small">${t('stack.tip')}</p>
      <p class="row"><button class="btn primary" data-shots="stack-go">📸 ${t('stack.go')}</button>
        <button class="btn" data-shots="end">${t('cancel')}</button></p>`;
    center(panel);
  }

  function endHunt() {
    finishBook();
    refresh();
  }

  // No live camera: the camera app, one photo at a time.
  function fallback() {
    stack = null; session.stack = false;
    const cam = (s, label) => `<label class="btn primary">📷 ${label}<input type="file" accept="image/*" capture="environment" hidden data-side="${s}"></label>`;
    panel.innerHTML = `<h2 class="shot-title"></h2><p class="shot-say"></p><p class="row"><span class="shot-cam"></span>
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
    document.removeEventListener('visibilitychange', onHidden);
    torch = false;
    best = null; spare = null; bestScore = 0; window0 = 0;
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }
  // Whatever was taken goes: the row of books, or the book begun (front only).
  async function finish() {
    if (stack) finishStack();
    else if (held) { finishBook(); sendLast(); }
    sendLast();
    await storing;
  }
  const onHidden = () => { if (document.visibilityState === 'hidden' && stream) stop({ hidden: true }); };
  // ✕, the screen going off, leaving the screen: the camera closes and everything taken
  // is sent (no question asked). The lines of what was sent stay.
  async function stop({ hidden = false } = {}) {
    stopCamera();
    await finish();
    stack = null;
    const done = panel.querySelector('.shot-done');
    panel.innerHTML = '';
    panel.onchange = null;
    if (hidden && done?.children.length) panel.insertAdjacentHTML('beforeend', `<p class="note">${t('burst.closed_hidden')}</p>`);
    if (done?.children.length) panel.append(done);
    panel.hidden = !panel.children.length;
    onEnd?.();
  }

  on.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shots]');
    if (!b) return;
    const act = b.dataset.shots;
    if (act === 'start') { onStart?.(); start(); }
    else if (act === 'stack') { onStart?.(); start({ many: true }); }
    else if (act === 'stack-go') start({ many: true, go: true });
    else if (act === 'stack-backs') toBacks();
    else if (act === 'skip' && stack?.phase === 'backs') tookStack(null);
    else if (act.startsWith('drop-')) {
      // A wrong photo in the strip of fronts.
      const i = Number(act.slice(5));
      const id = stack.ids[i];
      storing = storing.then(async () => discard(await id)).catch(() => {});
      stack.fronts.splice(i, 1); stack.ids.splice(i, 1); stack.frontAt.splice(i, 1);
      refresh();
    }
    else if (act === 'snap') snap(false);
    else if (act === 'torch') toggleTorch();
    else if (act === 'end') stop();
    else if (act === 'skip' && front) endHunt();
    else if (act === 'nocode') endHunt();
    else if (act.startsWith('retake-')) retake(act.slice(7));
  });
  panel.hidden = true;
  return { start, stop };
}

// Where a book's pictures go. With a barcode read: straight to the library (direct:
// 'sighting') or to My books (direct: 'mine'); a barcode no catalogue knows falls back
// (alt) to the covers, which the server reads; the book then waits in the approval queue.
// pos: the position, or a function giving it (it may arrive later).
export function coversTarget({ code = null, kind = 'seen', pos = null, owner = null, friend_name: friend = null, replaces = null, direct = null } = {}) {
  return ({ isbn = null } = {}) => {
    const p = typeof pos === 'function' ? pos() : pos;
    const at = { lat: p?.lat ?? '', lon: p?.lon ?? '' };
    const covers = { url: '/api/covers', fields: { code, kind, isbn, owner, friend_name: friend, replaces, lang: lang(), ...at } };
    if (isbn && direct === 'sighting' && code) return { url: `/api/locations/${code}/sightings`, fields: { isbn, kind, ...at }, alt: covers };
    if (isbn && direct === 'mine') return { url: '/api/my-books', fields: { isbn }, alt: covers };
    return covers;
  };
}
// The line for a book once sent: its title when the catalogue knew it, else "read later".
export function bookSentLine(data) {
  if (data?.book?.title) return `<span class="ok">✓ ${esc(data.book.title)}</span>${data.sighting && data.sighting.status !== 'approved' ? ` <span class="muted small">${t('mybooks.pending')}</span>` : ''}`;
  return `📤 ${t('shots.reading_later')}`;
}
