import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, timeAgo, toast, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';
import { placeBook, ownerLabel } from '../mybooks.js';
import { bookShots, sendCovers } from '../shots.js';
import { rememberList } from '../pager.js';

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
  async function showLists() {
    let d;
    try { d = await api('/api/my-books'); } catch { $('#lists').innerHTML = `<p class="note">${t('offline')}</p>`; return; }
    $('#lists').innerHTML = `
      <h2>${t('mybooks.home')} <span class="count">${d.home.length}</span></h2>
      ${d.home.length ? `<ul class="books">${d.home.map((r) => `
        <li data-id="${r.id}"><a href="/books/${r.id}" data-book>${cover(r)}</a><div class="meta">
          <a class="title-link" href="/books/${r.id}" data-book><strong>${esc(r.title)}</strong></a><span class="muted">${esc((r.authors ?? []).join(', '))}</span>
          <span class="row"><button class="btn small primary" data-place="${r.id}">📍 ${t('mybooks.left_it')}</button>
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
  }
  let homeRows = [];
  $('#lists').addEventListener('click', async (e) => {
    const p = e.target.closest('[data-place]'), del = e.target.closest('[data-del]');
    if (p) {
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

// Adding books: one way only — photograph the front and the back, book after book.
// A barcode the camera catches adds the book at once; anything else is read from the
// covers in the background and waits in the approval queue, to confirm or fix.
export async function addMyBooksView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/books/add', { replace: true });
  root.innerHTML = `
  <section class="page">
    <p><a href="/books">${t('mybooks.back')}</a></p>
    <h1>${t('mybooks.add_title')}</h1>
    <div class="big-actions">
      <button class="big-btn primary" data-shots="start"><span>📕</span><b>${t('mybooks.add_big')}</b><small>${t('mybooks.add_big_note')}</small></button>
    </div>
    <p class="note">${t('mybooks.add_how')}</p>
    <div class="shots" id="shots" hidden></div>
    <p id="queue-link"></p>
  </section>`;
  const queueLink = root.querySelector('#queue-link');
  const showQueue = () => api('/api/queue/count').then((c) => {
    queueLink.innerHTML = c.open + c.later || c.processing ? `<a class="btn" href="/queue">📥 ${t('queue.link', c)}</a>` : '';
  }).catch(() => {});
  showQueue();
  const shots = bookShots({ on: root, panel: root.querySelector('#shots'), onBook: async ({ front, back, isbn }) => {
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
  return () => shots.stop();
}
