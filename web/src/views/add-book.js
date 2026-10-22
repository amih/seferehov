import { api, getMe } from '../api.js';
import { enqueue } from '../queue.js';
import { navigate } from '../nav.js';
import { esc, getPosition, shrinkImage, noStringsNote } from '../ui.js';
import { t, lang } from '../i18n.js';
import { placeBook } from '../mybooks.js';
import { bookShots, sendCovers } from '../shots.js';
import { burstShots } from '../burst.js';

// Three ways in: shelf photos taken by themselves while the reader moves along the
// shelves (burst.js), photos from the camera app, or one book's front and back covers
// (the live camera also catches its barcode). Photos upload in the background so the
// next ones can be taken right away; every book found waits in the approval queue.
export default async function addBookView(root, [code], query) {
  const me = await getMe();
  if (!me) return navigate(`/login?next=/l/${code}/add`, { replace: true });
  let mode = query?.get('kind') === 'added' ? 'added' : 'seen';

  root.innerHTML = `
  <section class="page">
    <p><a href="/l/${code}">${t('back.library')}</a></p>
    <h1>${t('addbook.title')}</h1>
    <div class="seg" id="mode"><button data-k="seen">${t('addbook.mode_seen')}</button><button data-k="added">${t('addbook.mode_added')}</button></div>
    <div class="big-actions">
      <button class="big-btn primary" id="burst"><span>📸</span><b>${t('add3.burst')}</b><small>${t('add3.burst_note')}</small></button>
      <label class="big-btn"><span>📷</span><b>${t('add3.photo')}</b><small>${t('add3.photo_note')}</small>
        <input type="file" accept="image/*" capture="environment" multiple hidden id="shelf"></label>
      <button class="big-btn" data-shots="start"><span>📕</span><b>${t('shots.start')}</b><small>${t('shots.start_note')}</small></button>
      <button class="big-btn" data-shots="stack"><span>📚</span><b>${t('stack.start')}</b><small>${t('stack.start_note')}</small></button>
    </div>
    <div class="shots" id="burst-panel" hidden></div>
    <div class="shots" id="shots" hidden></div>
    <div class="from-mine" id="from-mine" hidden></div>
    <ul class="uploads" id="uploads"></ul>
    <p id="queue-link"></p>
    <p class="muted small">${t('addbook.shelf_lead')}</p>
    ${noStringsNote()}
  </section>`;

  let pos = null;
  getPosition().then((p) => { pos = p; }).catch(() => {});
  const showMode = () => {
    root.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('on', x.dataset.k === mode));
  };
  showMode();
  root.querySelector('#mode').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) { mode = b.dataset.k; showMode(); }
  };

  let photos = 0;
  const queueLink = root.querySelector('#queue-link');
  async function showQueue() {
    try {
      const c = await api('/api/queue/count');
      queueLink.innerHTML = `${photos ? `<a class="btn primary" href="/l/${code}/check">🔎 ${t('check.title')}</a> ` : ''}${
        c.open + c.later || c.processing ? `<a class="btn" href="/queue">📥 ${t('queue.link', c)}</a>` : ''}`;
    } catch { /* offline */ }
  }
  showQueue();

  // Books the reader scanned at home: one tap reports one of them left here.
  const fromMine = root.querySelector('#from-mine');
  async function showMine() {
    const d = await api('/api/my-books').catch(() => null);
    fromMine.hidden = !d?.home.length;
    if (!d?.home.length) return;
    fromMine.innerHTML = `<p><b>${t('mybooks.from_mine')}</b></p><p class="row">${d.home.map((r) =>
      `<button class="btn small" data-mine="${r.id}">📍 ${esc(r.title)}</button>`).join('')}</p>`;
    fromMine.onclick = async (e) => {
      const b = e.target.closest('[data-mine]');
      const item = b && d.home.find((r) => r.id === Number(b.dataset.mine));
      if (item && await placeBook(item, code)) showMine();
    };
  }
  showMine();

  // One line per upload, so the next photo can be taken while this one is still sending.
  const list = root.querySelector('#uploads');
  async function upload(files, label, li = null) {
    if (!li) {
      li = document.createElement('li');
      li.innerHTML = `<span class="spinner"></span> ${esc(label)} — ${t('addbook.uploading')}`;
      list.prepend(li);
    }
    const url = `/api/locations/${code}/scans`;
    const fields = { kind: mode, lang: lang(), lat: pos?.lat ?? '', lon: pos?.lon ?? '' };
    const offline = async () => { await enqueue(url, fields, files, 'shelf'); li.textContent = `💾 ${label} — ${t('addbook.queued_offline')}`; };
    if (!navigator.onLine) return offline();
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    Object.entries(files).forEach(([k, b]) => fd.append(k, b, b.name || `${k}.jpg`));
    try {
      await api(url, { method: 'POST', form: fd });
      li.textContent = `✓ ${label} — ${t('add3.sent')}`;
      showQueue();
    } catch (e) {
      if (e instanceof TypeError) return offline();
      li.textContent = `⚠️ ${label} — ${e.status === 413 ? t('addbook.too_large') : e.message}`;
    }
  }
  root.querySelector('#shelf').onchange = async (e) => {
    const picked = [...e.target.files].slice(0, 8);
    e.target.value = '';
    if (!picked.length) return;
    const files = {};
    for (const [i, f] of picked.entries()) files[`photo${i}`] = await shrinkImage(f, 2400);
    photos += picked.length;
    upload(files, picked.length === 1 ? t('add3.photo_n', { n: photos }) : t('add3.photos_n', { n: picked.length }));
  };

  // Each batch of photos the camera took by itself is one scan (its line shows in the panel).
  const burst = burstShots({ panel: root.querySelector('#burst-panel'), onBatch: async (blobs) => {
    const li = document.createElement('li');
    photos += blobs.length;
    await upload(Object.fromEntries(blobs.map((b, i) => [`photo${i}`, b])), t('add3.photos_n', { n: blobs.length }), li);
    showQueue();
    return li.innerHTML;
  } });
  root.querySelector('#burst').onclick = async () => {
    shots.stop();
    if (!await burst.start()) root.querySelector('#shelf').click();
  };

  // Front and back photos of one book: a known barcode is reported here now; anything
  // else is read from the covers on the server and waits in the queue.
  const shots = bookShots({ on: root, panel: root.querySelector('#shots'), onStart: () => burst.stop(), onBook: async ({ front, back, isbn }) => {
    if (isbn && navigator.onLine) {
      const fd = new FormData();
      Object.entries({ isbn, kind: mode, lat: pos?.lat ?? '', lon: pos?.lon ?? '' }).forEach(([k, v]) => fd.append(k, v));
      fd.append('photo', front, 'photo.jpg');
      if (back) fd.append('back', back, 'back.jpg');
      try {
        const r = await api(`/api/locations/${code}/sightings`, { method: 'POST', form: fd });
        return `<span class="ok">✓ ${esc(r.book.title)}</span>${r.sighting.status === 'approved' ? '' : ` <span class="muted small">${t('mybooks.pending')}</span>`}`;
      } catch (e) {
        if (e.body?.error !== 'book_not_found' && !(e instanceof TypeError)) throw e;
      }
    }
    const line = await sendCovers({ code, kind: mode, pos, isbn, front, back });
    showQueue();
    return line;
  } });
  return () => { shots.stop(); burst.stop(false); };
}
