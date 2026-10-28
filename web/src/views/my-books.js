import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, timeAgo, toast, confirmDialog } from '../ui.js';
import { t, lang } from '../i18n.js';
import { enqueue } from '../queue.js';
import { placeBook, ownerLabel } from '../mybooks.js';
import { bookShots, sendCovers } from '../shots.js';
import { burstShots } from '../burst.js';
import { offerDialog, offerLine } from '../offers.js';
import { rememberList } from '../pager.js';
import { bookFacts, GENRES, LANGUAGES } from '../genres.js';

// The reader's own books, scanned at home. Later, "I left it in a library" reports it there.
// Adding is on its own screen (/books/add), so this one is just the list.
export default async function myBooksView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/books', { replace: true });

  root.innerHTML = `
  <section class="page">
    <h1>${t('mybooks.title')}</h1>
    <p class="muted">${t('mybooks.lead')}</p>
    <p class="row"><a class="btn primary" href="/books/add">${t('mybooks.add_btn')}</a><span id="queue-link"></span></p>
    <div id="lists"><p class="muted">${t('loading')}</p></div>
  </section>`;

  const $ = (s) => root.querySelector(s);
  api('/api/queue/count').then((c) => {
    if (c.open + c.later) $('#queue-link').innerHTML = `<a class="btn" href="/queue">📥 ${t('queue.link', c)}</a>`;
  }).catch(() => {});

  const cover = (r) => (r.photo?.thumb || r.cover_url
    ? `<img src="${esc(r.photo?.thumb || r.cover_url)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>');
  // Narrowing and ordering the home list, on the phone (the whole list is loaded).
  const view = { text: '', genre: '', language: '', sort: 'added' };
  const norm = (x) => String(x ?? '').toLowerCase();
  const order = {
    added: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title, lang()),
    author: (a, b) => norm(a.authors?.[0]).localeCompare(norm(b.authors?.[0]), lang()),
    year_new: (a, b) => (b.year ?? 0) - (a.year ?? 0),
    year_old: (a, b) => (a.year ?? 9999) - (b.year ?? 9999),
  };
  const narrow = (rows) => rows.filter((r) => (!view.genre || r.genre === view.genre) && (!view.language || r.language === view.language)
    && (!view.text || norm(`${r.title} ${(r.authors ?? []).join(' ')}`).includes(norm(view.text)))).sort(order[view.sort]);
  const toolbar = (rows) => {
    const has = (k) => new Set(rows.map((r) => r[k]).filter(Boolean));
    const sel = (k, values, prefix) => `<select data-view="${k}"><option value="">${t(`browse.${k}`)}: ${t('browse.any')}</option>${values.filter((v) => has(k).has(v)).map((v) =>
      `<option value="${v}"${view[k] === v ? ' selected' : ''}>${esc(t(`${prefix}.${v}`))} (${rows.filter((r) => r[k] === v).length})</option>`).join('')}</select>`;
    return `<div class="filters"><input type="search" data-view="text" value="${esc(view.text)}" placeholder="${esc(t('browse.filter_ph'))}">
      ${sel('genre', GENRES, 'genre')}${sel('language', LANGUAGES, 'language')}
      <select data-view="sort">${Object.keys(order).map((k) => `<option value="${k}"${view.sort === k ? ' selected' : ''}>${t(`sort.${k}`)}</option>`).join('')}</select></div>`;
  };
  let d;
  async function showLists() {
    try { d = await api('/api/my-books'); } catch { $('#lists').innerHTML = `<p class="note">${t('offline')}</p>`; return; }
    draw();
  }
  function draw() {
    const all = d.home;
    d = { ...d, home: narrow(all) };
    $('#lists').innerHTML = `
      <h2>${t('mybooks.home')} <span class="count">${all.length}</span></h2>
      ${all.length > 5 ? toolbar(all) : ''}
      ${d.home.length ? `<p class="muted small">${t('offer.lead')} <a href="/offers">${t('offer.all_link')}</a></p>` : ''}
      ${d.home.length ? `<ul class="books">${d.home.map((r) => `
        <li data-id="${r.id}"><a href="/books/${r.id}" data-book>${cover(r)}</a><div class="meta">
          <a class="title-link" href="/books/${r.id}" data-book><strong>${esc(r.title)}</strong></a><span class="muted">${esc((r.authors ?? []).join(', '))}</span>
          ${bookFacts(r) ? `<span class="small muted">${esc(bookFacts(r))}</span>` : ''}
          ${offerLine(r)}
          <span class="row"><button class="btn small primary" data-place="${r.id}">📍 ${t('mybooks.left_it')}</button>
          <button class="btn small" data-offer="${r.id}">${r.offer ? `✎ ${t('offer.edit')}` : `🏷️ ${t('offer.btn')}`}</button>
          <button class="btn small" data-del="${r.id}" aria-label="${esc(t('mybooks.remove'))}">✕</button></span></div></li>`).join('')}</ul>`
        : `<p class="muted small">${t('mybooks.empty2')}</p>`}
      ${d.friends.length ? `<h2>${t('owner.friends_title')} <span class="count">${d.friends.length}</span></h2>
      <ul class="books">${d.friends.map((r) => `
        <li data-id="${r.id}"><a href="/books/${r.id}" data-book>${cover(r)}</a><div class="meta">
          <a class="title-link" href="/books/${r.id}" data-book><strong>${esc(r.title)}</strong></a><span class="muted">${esc((r.authors ?? []).join(', '))}</span>
          <span class="small">${ownerLabel(r)}</span>
          <span class="row"><button class="btn small" data-del="${r.id}" aria-label="${esc(t('mybooks.remove'))}">✕</button></span></div></li>`).join('')}</ul>` : ''}
      ${d.placed.length ? `<h2>${t('mybooks.placed_title')} <span class="count">${d.placed.length}</span></h2>
      <ul class="books">${d.placed.map((r) => `
        <li><a href="/books/${r.id}" data-book>${cover(r)}</a><div class="meta">
          <a class="title-link" href="/books/${r.id}" data-book><strong>${esc(r.title)}</strong></a>
          <span class="muted">${esc((r.authors ?? []).join(', '))}</span>
          <span class="small">📍 <a href="/l/${r.code}">${esc(r.location_name || t('free_library'))}</a> · ${timeAgo(r.placed_at)}${r.sighting_status === 'pending' ? ` · ${t('mybooks.pending')}` : ''}</span></div></li>`).join('')}</ul>` : ''}`;
    homeRows = [...d.home, ...d.friends];
    d = { ...d, home: all };
  }
  let homeRows = [];
  $('#lists').addEventListener('input', (e) => {
    const k = e.target.dataset?.view;
    if (!k) return;
    view[k] = e.target.value;
    const focus = k === 'text' ? e.target.selectionStart : null;
    draw();
    if (focus != null) { const i = $('[data-view="text"]'); i.focus(); i.setSelectionRange(focus, focus); }
  });
  $('#lists').addEventListener('click', async (e) => {
    const p = e.target.closest('[data-place]'), del = e.target.closest('[data-del]'), off = e.target.closest('[data-offer]');
    if (off) {
      const item = homeRows.find((r) => r.id === Number(off.dataset.offer));
      if (item && await offerDialog(item)) showLists();
    } else if (p) {
      const item = homeRows.find((r) => r.id === Number(p.dataset.place));
      if (item && await placeBook(item)) showLists();
    } else if (del) {
      const item = homeRows.find((r) => r.id === Number(del.dataset.del));
      if (!await confirmDialog(t('mybooks.remove_confirm', { title: esc(item?.title ?? '') }), t('mybooks.remove'))) return;
      await api(`/api/my-books/${del.dataset.del}`, { method: 'DELETE' }).catch((err) => toast(err.message));
      showLists();
    }
  });

  rememberList(root);
  showLists();
}

// Adding books: photograph the front and the back, book after book (a barcode the camera
// catches adds the book at once; anything else is read from the covers), or the shelves
// with photos taken by themselves (burst.js), read for spines. All but caught barcodes
// are read in the background and wait in the approval queue, to confirm or fix.
export async function addMyBooksView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/books/add', { replace: true });
  root.innerHTML = `
  <section class="page">
    <p><a href="/books">${t('mybooks.back')}</a></p>
    <h1>${t('mybooks.add_title')}</h1>
    <div class="big-actions">
      <button class="big-btn primary" data-shots="start"><span>📕</span><b>${t('mybooks.add_big')}</b><small>${t('mybooks.add_big_note')}</small></button>
      <button class="big-btn" data-shots="stack"><span>📚</span><b>${t('stack.start')}</b><small>${t('stack.start_note')}</small></button>
      <button class="big-btn" id="burst"><span>📸</span><b>${t('mybooks.shelf_big')}</b><small>${t('add3.burst_note')}</small></button>
    </div>
    <p class="note">${t('mybooks.add_how')}</p>
    <p class="muted small">💡 ${t('mybooks.add_tips')}</p>
    <div class="shots" id="shots" hidden></div>
    <div class="shots" id="burst-panel" hidden></div>
    <p id="queue-link"></p>
  </section>`;
  const queueLink = root.querySelector('#queue-link');
  const showQueue = () => api('/api/queue/count').then((c) => {
    queueLink.innerHTML = c.open + c.later || c.processing ? `<a class="btn" href="/queue">📥 ${t('queue.link', c)}</a>` : '';
  }).catch(() => {});
  showQueue();
  const shots = bookShots({ on: root, panel: root.querySelector('#shots'), onStart: () => burst.stop(), onBook: async ({ front, back, isbn }) => {
    if (isbn && navigator.onLine) {
      const fd = new FormData();
      fd.append('isbn', isbn);
      fd.append('photo', front, 'photo.jpg');
      if (back) fd.append('back', back, 'back.jpg');
      try {
        const r = await api('/api/my-books', { method: 'POST', form: fd });
        return `<span class="ok">✓ ${esc(r.book.title)}</span>`;
      } catch (e) {
        if (e.body?.error !== 'book_not_found' && !(e instanceof TypeError)) throw e;
      }
    }
    const line = await sendCovers({ isbn, front, back, owner: 'mine' });
    showQueue();
    return line;
  } });
  const burst = burstShots({ screen: 'home', panel: root.querySelector('#burst-panel'), onBatch: async (blobs) => {
    const line = await sendShelf(blobs);
    showQueue();
    return line;
  } });
  root.querySelector('#burst').onclick = async () => {
    shots.stop();
    if (!await burst.start()) toast(t('burst.no_camera'));
  };
  return () => { shots.stop(); burst.stop(false); };
}

// Shelf photos taken at home: read for spines; the books found wait in the queue.
async function sendShelf(blobs) {
  const files = Object.fromEntries(blobs.map((b, i) => [`photo${i}`, b]));
  const fields = { owner: 'mine', lang: lang() };
  try {
    if (!navigator.onLine) throw new TypeError('offline');
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
    Object.entries(files).forEach(([k, b]) => fd.append(k, b, `${k}.jpg`));
    await api('/api/my-books/scans', { method: 'POST', form: fd });
    return `📤 ${esc(t('add3.photos_n', { n: blobs.length }))} — ${t('shots.reading_later')}`;
  } catch (err) {
    if (!(err instanceof TypeError)) return `⚠️ ${esc(err.status === 413 ? t('addbook.too_large') : err.message)}`;
    await enqueue('/api/my-books/scans', fields, files, 'shelf');
    return `💾 ${t('bc.saved_offline')}`;
  }
}
