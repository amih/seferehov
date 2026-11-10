import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, getPosition, noStringsNote, toast } from '../ui.js';
import { queueCount } from '../todo.js';
import { t, lang } from '../i18n.js';
import { placeBook } from '../mybooks.js';
import { captureShots, captureFiles } from '../capture.js';

// One camera for everything (capture.js): shelves, front covers and back covers, in any
// order; the server sorts the photos and pairs the covers. Or photos from the camera app,
// sorted the same way. Every photo is saved on the phone and sent by itself; every book
// found waits in the approval queue.
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
      <button class="big-btn primary" id="capture"><span>📸</span><b>${t('capture.start')}</b><small>${t('capture.start_note')}</small></button>
      <label class="big-btn"><span>🖼️</span><b>${t('capture.files')}</b><small>${t('capture.files_note')}</small>
        <input type="file" accept="image/*" multiple hidden id="files"></label>
    </div>
    <div class="shots" id="capture-panel" hidden></div>
    <div class="from-mine" id="from-mine" hidden></div>
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
      const c = await queueCount({ maxAge: 0 });
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

  const request = () => ({ code, kind: mode, lang: lang(), lat: pos?.lat ?? '', lon: pos?.lon ?? '' });
  root.querySelector('#files').onchange = async (e) => {
    const n = await captureFiles(e.target.files, request);
    e.target.value = '';
    if (n) { photos += n; toast(t('capture.sent', { n })); showQueue(); }
  };
  const cam = captureShots({ panel: root.querySelector('#capture-panel'), request, onEnd: (n) => { photos += n; showQueue(); } });
  root.querySelector('#capture').onclick = async () => {
    if (!await cam.start()) root.querySelector('#files').click();
  };
  return () => { cam.stop(false); };
}
