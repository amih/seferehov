import { api, getMe } from '../api.js';
import { enqueue } from '../queue.js';
import { navigate } from '../nav.js';
import { startScanner, scanImage } from '../scanner.js';
import { esc, getPosition, toast } from '../ui.js';
import { t, lang } from '../i18n.js';
import { bookShots, coversTarget, bookSentLine } from '../shots.js';
import { chime } from '../sound.js';

// Live barcode scanning, one book after another. Each barcode is looked up and put
// in the approval queue; the camera keeps running for the next book.
export default async function barcodeView(root, [code], query) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=/l/${code}/barcode`, { replace: true });
  const kind = query?.get('kind') === 'added' ? 'added' : 'seen';

  root.innerHTML = `
  <section class="page">
    <p><a href="/l/${code}/add">${t('back.add')}</a></p>
    <h1>${t('add3.barcode')}</h1>
    <div class="scanner live"><video muted playsinline></video><div class="frame"></div></div>
    <p class="row" id="cam-row" hidden>
      <button class="btn primary" id="cam">${t('addbook.start')}</button>
      <label class="btn">${t('addbook.photo')}<input type="file" accept="image/*" capture="environment" hidden id="still"></label>
    </p>
    <p class="decoded" id="decoded" dir="ltr">${t('bc.point')}</p>
    <div id="result"></div>
    <div class="shots" id="shots" hidden></div>
    <form id="manual" class="row form-inline">
      <input name="isbn" inputmode="numeric" placeholder="${t('addbook.isbn_ph')}" dir="ltr" autocomplete="off">
      <button class="btn">${t('add')}</button>
    </form>
    <h2>${t('bc.this_visit')} <span class="count" id="n">0</span></h2>
    <ul class="added" id="added"></ul>
    <p><a class="btn big primary" href="/queue" id="to-queue">📥 ${t('bc.to_queue')}</a></p>
  </section>`;

  const video = root.querySelector('video');
  const decoded = root.querySelector('#decoded');
  const result = root.querySelector('#result');
  const added = root.querySelector('#added');
  const done = new Set();
  let pos = null;
  getPosition().then((p) => { pos = p; }).catch(() => {});

  const say = (text, isbn = false) => { decoded.textContent = text; decoded.classList.toggle('isbn', isbn); };
  async function handleIsbn(isbn) {
    say(isbn, true);
    if (done.has(isbn)) { result.innerHTML = `<p class="note">${t('bc.already')}</p>`; return; }
    done.add(isbn);
    result.innerHTML = `<p class="muted">${t('addbook.looking', { isbn: esc(isbn) })}</p>`;
    const url = `/api/locations/${code}/barcode`;
    const fields = { isbn, kind, lang: lang(), lat: pos?.lat ?? '', lon: pos?.lon ?? '' };
    let r;
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      r = await api(url, { method: 'POST', form: fd });
    } catch (e) {
      // Refused (a wrong number): said at once. No signal, or the server busy: kept on the phone and sent later.
      if (!(e instanceof TypeError) && e.status < 500 && e.status !== 429 && e.status !== 401) {
        done.delete(isbn);
        result.innerHTML = `<p class="note">${e.body?.error === 'invalid_isbn' ? t('addbook.invalid') : esc(e.message)}</p>`;
        return;
      }
      await enqueue(url, fields, {}, 'book');
      r = { offline: true };
    }
    const b = r.book;
    result.innerHTML = `
      <div class="card book-card">
        ${b?.cover_url ? `<img src="${esc(b.cover_url)}" alt="">` : '<div class="nocover">📖</div>'}
        <div><strong>${esc(b?.title ?? `ISBN ${isbn}`)}</strong><br>
          <span class="muted">${esc(b?.authors?.join(', ') ?? (r.offline ? '' : t('bc.unknown')))}</span><br>
          <span class="ok">✓ ${t(r.offline ? 'bc.saved_offline' : r.merged ? 'bc.merged' : 'bc.queued')}</span></div>
      </div>
      ${b && r.missing?.length ? `<p class="note">${t(`shots.partial_${r.missing.join('_')}`)}</p>
        <p><button class="btn primary" id="shoot-missing">📷 ${t('shots.add_missing')}</button></p>` : ''}`;
    // Not in any catalogue: straight to the camera, the reader completes the record.
    // Found: on to the next barcode (with an offer when its pictures are missing).
    const shoot = (intro) => { stop?.(); stop = null; root.querySelector('.scanner').hidden = true; shots.start({ isbn, intro, single: true }); };
    if (!b && !r.offline) { chime('missing'); shoot(t('shots.contribute')); }
    else if (b) chime(r.missing?.length ? 'partial' : 'found');
    const more = result.querySelector('#shoot-missing');
    if (more) more.onclick = () => shoot(t(`shots.partial_${r.missing.join('_')}`));
    added.insertAdjacentHTML('afterbegin', `<li>${esc(b?.title ?? `ISBN ${isbn}`)}</li>`);
    root.querySelector('#n').textContent = done.size;
    if (r.open != null) root.querySelector('#to-queue').textContent = `📥 ${t('bc.to_queue')} (${r.open + r.later})`;
  }

  let stop = null, left = false;
  const camBtn = root.querySelector('#cam');
  async function start() {
    try {
      stop = await startScanner(video, handleIsbn);
      root.querySelector('#cam-row').hidden = true;
    } catch (err) {
      root.querySelector('#cam-row').hidden = false;
      toast(t(err.name === 'NotAllowedError' ? 'cam.denied' : 'cam.fail'));
    }
  }
  camBtn.onclick = start;
  start();

  // A barcode no catalogue knows: one book's covers, then back to scanning.
  const shots = bookShots({
    on: root, panel: root.querySelector('#shots'), onEnd: () => { if (left || stop) return; root.querySelector('.scanner').hidden = false; start(); },
    target: (x) => coversTarget({ code, kind, pos: () => pos })(x),
    sent: (data) => { result.innerHTML = `<p>${bookSentLine(data)} ${t('shots.thanks')}</p>`; return null; },
  });

  root.querySelector('#still').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    say(t('addbook.reading'));
    const isbn = await scanImage(file).catch(() => null);
    if (isbn) handleIsbn(isbn);
    else { say(t('bc.point')); result.innerHTML = `<p class="note">${t('addbook.nofound')}</p>`; }
  };
  root.querySelector('#manual').onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.isbn.value.replace(/[^0-9Xx-]/g, ''); // dashes: Danacode short form "31-4090"
    if (v) handleIsbn(v);
    e.target.reset();
  };

  return () => { left = true; stop?.(); stop = null; shots.stop(); };
}
