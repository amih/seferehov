import { api } from '../api.js';
import { navigate, backCloses } from '../nav.js';
import { esc, timeAgo, toast, confirmDialog, getPosition } from '../ui.js';
import { t } from '../i18n.js';
import { watchDialog } from '../watch.js';
import { pagerHtml, attachPager, loadBook } from '../pager.js';
import { bookShots } from '../shots.js';
import { placeBook, ownerLabel } from '../mybooks.js';
import { reviewBox } from '../review.js';

// One book at one library: large pictures (photos taken at the shelf, the front and
// back covers found online), the back-cover text, and whether it is still there.
const NEAR_M = 300; // close enough to the library to photograph a book on its shelf

export default async function bookView(root, [code, id], _q, fresh = false) {
  if (!fresh) root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  let data;
  try { data = await loadBook(`/l/${code}/b/${id}`, { fresh }); } catch (e) {
    root.innerHTML = `<section class="page"><h1>${t(e.status === 404 ? 'notfound.title' : 'offline')}</h1><p><a href="/l/${code}">${t('back.library')}</a></p></section>`;
    return;
  }
  const { book: b, photos, here, waiting, location: l } = data;
  // "Tell me when it shows up" only when it is not on the shelf now.
  const present = here?.present;
  return renderBook(root, {
    b, photos, again: () => bookView(root, [code, id], null, true),
    // Whoever stands at the library (the book in hand) can photograph its covers.
    photoSaver: async () => {
      const p = await getPosition({ timeout: 8000 }).catch(() => null);
      if (!p || distanceM(p, l) > NEAR_M) return null;
      return async ({ front, back }) => {
        const fd = new FormData();
        if (front) fd.append('photo', front, 'photo.jpg');
        if (back) fd.append('back', back, 'back.jpg');
        fd.append('lat', p.lat); fd.append('lon', p.lon);
        const r = await api(`/api/locations/${code}/books/${id}/photos`, { method: 'POST', form: fd });
        if (r.sighting.status !== 'approved') toast(t('loc.thanks_review'));
      };
    },
    back: `<a href="/l/${code}">${t('back.to', { name: esc(l.name || t('free_library')) })}</a>`,
    status: here ? `<p class="${present ? 'ok' : 'muted'}">${present ? t('book.here', { when: timeAgo(here.at) }) : t(here.kind === 'gone' ? 'loc.gone_when' : 'loc.taken_when', { when: timeAgo(here.at) })}</p>` : '',
    actions: `${waiting?.others ? `<p class="waiting">👥 ${t('watch.waiting', { n: waiting.others, mine: waiting.mine })}</p>` : ''}
      ${present && !waiting?.mine ? '' : `<p class="row"><button class="btn" id="watch">${t(waiting?.mine ? 'watch.on' : 'watch.button')}</button></p>`}`,
    wire: (el) => { const w = el.querySelector('#watch'); if (w) w.onclick = () => watchDialog({ book: { ...b, waiting }, code }); },
  });
}

// One of the reader's own books (My books).
export async function myBookView(root, [id], _q, fresh = false) {
  if (!fresh) root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  let data;
  try { data = await loadBook(`/books/${id}`, { fresh }); } catch (e) {
    root.innerHTML = `<section class="page"><h1>${t(e.status === 404 ? 'notfound.title' : 'offline')}</h1><p><a href="/books">${t('mybooks.back')}</a></p></section>`;
    return;
  }
  const { item, book: b, photos } = data;
  return renderBook(root, {
    b, photos, again: () => myBookView(root, [id], null, true),
    photoSaver: async () => async ({ front, back }) => {
      const fd = new FormData();
      if (front) fd.append('photo', front, 'photo.jpg');
      if (back) fd.append('back', back, 'back.jpg');
      await api(`/api/my-books/${item.id}/photos`, { method: 'POST', form: fd });
      toast(t('shots.thanks'));
    },
    back: `<a href="/books">${t('mybooks.back')}</a>`,
    status: item.placed_at ? `<p class="ok">📍 <a href="/l/${item.code}">${esc(item.location_name || t('free_library'))}</a> · ${timeAgo(item.placed_at)}</p>`
      : `<p class="muted">${item.owner === 'mine' ? t('mybooks.home') : ownerLabel(item)}</p>`,
    actions: item.placed_at ? '' : `<p class="row">${item.owner === 'mine' ? `<button class="btn primary" id="place">📍 ${t('mybooks.left_it')}</button>` : ''}
      <button class="btn" id="remove">✕ ${t('mybooks.remove')}</button></p>`,
    wire: (el) => {
      const p = el.querySelector('#place');
      if (p) p.onclick = async () => { if (await placeBook({ id: item.id, title: b.title })) myBookView(root, [id]); };
      const r = el.querySelector('#remove');
      if (r) r.onclick = async () => {
        if (!await confirmDialog(t('mybooks.remove_confirm', { title: esc(b.title) }), t('mybooks.remove'))) return;
        await api(`/api/my-books/${item.id}`, { method: 'DELETE' }).catch((err) => toast(err.message));
        navigate('/books', { replace: true });
      };
    },
  });
}

const distanceM = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad), y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * R;
};

function renderBook(root, { b, photos, again, back, status, actions, wire, photoSaver }) {
  root._bookCleanup?.(); // the page re-renders when the details arrive
  // Covers and the back-cover text are still being looked up: show this, then look again.
  const path = location.pathname;
  let timer = null;
  if (b.details_pending) timer = setTimeout(() => { if (location.pathname === path) again(); }, 6000);

  // Front and back covers photographed by readers say it all: then only those two.
  // Otherwise a cover photo taken at the shelf first, then the covers found online (so a
  // blurry spine is never all there is), then the spine cut-outs and whole-shelf photos.
  const latest = (kind) => photos.find((p) => p.kind === kind);
  const own = latest('cover') && latest('back')
    ? [{ url: latest('cover').url, label: t('book.pic_cover_here', { when: timeAgo(latest('cover').at) }) },
      { url: latest('back').url, label: t('book.pic_back_here', { when: timeAgo(latest('back').at) }) }]
    : null;
  const pics = own ?? [
    ...photos.filter((p) => p.kind === 'cover').map((p) => ({ url: p.url, label: t('book.pic_cover_here', { when: timeAgo(p.at) }) })),
    ...photos.filter((p) => p.kind === 'back').map((p) => ({ url: p.url, label: t('book.pic_back_here', { when: timeAgo(p.at) }) })),
    ...(b.front_url || b.cover_url ? [{ url: b.front_url || b.cover_url, label: t('book.pic_front') }] : []),
    ...(b.back_url ? [{ url: b.back_url, label: t('book.pic_back') }] : []),
    ...photos.filter((p) => p.kind === 'spine').map((p) => ({ url: p.url, label: t('book.pic_spine', { when: timeAgo(p.at) }), wide: true })),
    ...photos.filter((p) => p.kind === 'shelf').map((p) => ({ url: p.url, label: t('book.pic_shelf', { when: timeAgo(p.at) }), wide: true })),
  ];

  root.innerHTML = `
  <section class="page book-page">
    <p>${back}</p>
    ${pagerHtml()}
    ${pics.length ? `<div class="gallery">${pics.map((p, i) => `
      <figure class="${p.wide ? 'wide' : ''}"><button class="pic" data-i="${i}" aria-label="${esc(p.label)}"><img src="${esc(p.url)}" alt="" loading="${i ? 'lazy' : 'eager'}"></button><figcaption>${esc(p.label)}</figcaption></figure>`).join('')}</div>
      ${pics.length > 1 ? `<p class="muted small center">${t('book.swipe', { n: pics.length })}</p>` : ''}` : '<div class="nocover big">📖</div>'}
    <div class="add-photos" hidden>
      ${!b.back_url && !latest('back') ? `<p class="note">${t('book.no_back')}</p>` : ''}
      <p class="row"><button class="btn ${!b.back_url && !latest('back') ? '' : 'small'}" data-new="front">📷 ${t('book.new_front')}</button>
        <button class="btn ${!b.back_url && !latest('back') ? 'primary' : 'small'}" data-new="back">📷 ${t('book.new_back')}</button></p></div>
    <div class="shots" id="shots" hidden></div>
    <h1>${esc(b.title)}</h1>
    <p>${esc((b.authors ?? []).join(', '))}${b.year ? ` · ${b.year}` : ''}${b.publisher ? ` · ${esc(b.publisher)}` : ''}</p>
    ${status}
    ${b.description ? `<h2>${t('book.blurb')}</h2><p class="desc blurb" dir="auto">${esc(b.description)}</p>`
      : b.details_pending ? `<p class="progress-line small"><span class="spinner"></span> ${t('book.looking')}</p>` : `<p class="muted small">${t('book.no_blurb')}</p>`}
    ${actions}
    ${(b.authors ?? []).length ? `<p class="row">${b.authors.slice(0, 2).map((a) => `<button class="link" data-watch-author="${esc(a)}">${esc(t('watch.author_button', { author: a }))}</button>`).join('')}</p>` : ''}
    <div id="review-box"></div>
    ${b.isbn13 ? `<p class="muted small" dir="ltr">ISBN ${esc(b.isbn13)}</p>` : ''}
    ${b.id ? `<p class="small"><a href="/b/${b.id}">${t('book.public_page')}</a></p>` : ''}
    ${b.details_source ? `<p class="muted small">${t('book.source', { src: esc(b.details_source) })}</p>` : ''}
  </section>`;

  wire(root);
  root.querySelectorAll('[data-watch-author]').forEach((el) => { el.onclick = () => watchDialog({ kind: 'author', query: el.dataset.watchAuthor }); });
  if (b.id) reviewBox(root.querySelector('#review-box'), b.id);
  root.querySelector('.gallery')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-i]');
    if (btn) viewer(pics, Number(btn.dataset.i));
  });
  // The reader holding the book can photograph a cover that is missing, or a better
  // one than what is shown (cut out and straightened on the server).
  let shots = null;
  if (photoSaver && !b.details_pending) {
    photoSaver().then((save) => {
      if (!save || location.pathname !== path) return;
      const box = root.querySelector('.add-photos');
      box.hidden = false;
      shots = bookShots({ on: root, panel: root.querySelector('#shots'), onBook: async ({ front, back }) => {
        await save({ front, back });
        toast(t('book.photo_saved'));
        again();
        return '';
      } });
      box.onclick = (e) => {
        const btn = e.target.closest('[data-new]');
        if (btn) { box.hidden = true; shots.start({ only: btn.dataset.new }); }
      };
    });
  }
  const unpage = attachPager(root);
  const cleanup = () => { clearTimeout(timer); unpage(); shots?.stop(); root._bookCleanup = null; };
  root._bookCleanup = cleanup;
  return () => root._bookCleanup?.(); // whichever render is current when leaving
}

// Full-screen picture, pinch to zoom, arrows/swipe between pictures.
function viewer(pics, start) {
  let i = start;
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `<button class="x" aria-label="${esc(t('menu.close'))}">✕</button>
    <div class="viewer-img"><img alt=""></div><p class="viewer-cap"></p>
    ${pics.length > 1 ? '<button class="prev" aria-label="‹">‹</button><button class="next" aria-label="›">›</button>' : ''}`;
  const img = el.querySelector('img');
  const show = () => { img.src = pics[i].url; el.querySelector('.viewer-cap').textContent = `${pics[i].label} (${i + 1}/${pics.length})`; };
  const step = (d) => { i = (i + d + pics.length) % pics.length; show(); };
  const remove = () => { el.remove(); document.removeEventListener('keydown', onKey); };
  const close = backCloses(remove); // the phone's back button closes it too
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
  el.addEventListener('click', (e) => {
    if (e.target.closest('.x')) close();
    else if (e.target.closest('.prev')) step(-1);
    else if (e.target.closest('.next')) step(1);
  });
  let x0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null || window.visualViewport?.scale > 1.05) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  });
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  show();
}
