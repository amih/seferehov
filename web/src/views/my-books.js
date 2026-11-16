import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, timeAgo, toast, confirmDialog } from '../ui.js';
import { queueCount } from '../todo.js';
import { t, lang } from '../i18n.js';
import { placeBook, ownerLabel } from '../mybooks.js';
import { captureShots, captureFiles } from '../capture.js';
import { offerDialog, offerLine } from '../offers.js';
import { rememberList } from '../pager.js';
import { bookFacts, GENRES, LANGUAGES } from '../genres.js';
import { setPublic } from '../invite.js';
import { sendBooks } from './invite.js';

// The reader's own books, scanned at home. Later, "I left it in a library" reports it there.
// Adding is on its own screen (/books/add), so this one is just the list.
export default async function myBooksView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/books', { replace: true });

  root.innerHTML = `
  <section class="page">
    <h1>${t('mybooks.title')}</h1>
    <p class="muted">${t('mybooks.lead')}</p>
    <p class="row"><a class="btn primary" href="/books/add">${t('mybooks.add_btn')}</a><a class="btn" href="/invite">💌 ${t('invite.menu')}</a><span id="queue-link"></span></p>
    <div id="lists"><p class="muted">${t('loading')}</p></div>
  </section>`;

  const $ = (s) => root.querySelector(s);
  queueCount().then((c) => {
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
          ${offerLine(r)}${r.public ? `<span class="small public-tag">${t('public.on')}</span>` : ''}
          <span class="row"><button class="btn small primary" data-place="${r.id}">📍 ${t('mybooks.left_it')}</button>
          <button class="btn small" data-public="${r.id}" title="${esc(t('public.note'))}">${t(r.public ? 'public.hide' : 'public.make')}</button>
          <button class="btn small" data-offer="${r.id}">${r.offer ? `✎ ${t('offer.edit')}` : `🏷️ ${t('offer.btn')}`}</button>
          <button class="btn small" data-del="${r.id}" aria-label="${esc(t('mybooks.remove'))}">✕</button></span></div></li>`).join('')}</ul>`
        : `<p class="muted small">${t('mybooks.empty2')}</p>`}
      ${d.friends.length ? `<h2>${t('owner.friends_title')} <span class="count">${d.friends.length}</span></h2>
      <p class="muted small">${t('invite.friends_lead')}</p>
      <p class="row">${friendGroups(d.friends).map((f, i) => `<button class="btn small" data-send="${i}">${esc(t('invite.send_to', { name: f.friend_name || t('owner.a_friend'), n: f.n }))}</button>`).join('')}</p>
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
    const pub = e.target.closest('[data-public]'), send = e.target.closest('[data-send]');
    if (send) {
      await sendBooks(friendGroups(d.friends)[Number(send.dataset.send)]);
    } else if (pub) {
      const item = homeRows.find((r) => r.id === Number(pub.dataset.public));
      if (!item) return;
      const r = await setPublic(`/api/my-books/${item.id}/public`, !item.public);
      if (r) { toast(t(r.public ? 'public.made' : 'public.hidden')); showLists(); }
    } else if (off) {
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

// Friends' books (at the friend's home, not borrowed), by the name given to the friend.
function friendGroups(rows) {
  const by = new Map();
  for (const r of rows.filter((x) => x.owner === 'friend')) {
    const k = r.friend_name ?? '';
    by.set(k, { friend_name: k, n: (by.get(k)?.n ?? 0) + 1 });
  }
  return [...by.values()];
}

// Adding books: one camera for everything (capture.js) — shelves, front covers, back
// covers, in any order. The server sorts the photos and pairs the covers; every book
// found waits in the approval queue, to confirm or fix.
export async function addMyBooksView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/books/add', { replace: true });
  root.innerHTML = `
  <section class="page">
    <p><a href="/books">${t('mybooks.back')}</a></p>
    <h1>${t('mybooks.add_title')}</h1>
    <div class="big-actions">
      <button class="big-btn primary" id="capture"><span>📸</span><b>${t('capture.start')}</b><small>${t('capture.start_note')}</small></button>
      <label class="big-btn"><span>🖼️</span><b>${t('capture.files')}</b><small>${t('capture.files_note')}</small>
        <input type="file" accept="image/*" multiple hidden id="files"></label>
    </div>
    <form class="owner-pick"><p>${t('owner.q')}</p>
      <p class="row"><label><input type="radio" name="owner" value="mine" checked> ${t('owner.mine')}</label>
      <label><input type="radio" name="owner" value="friend"> ${t('owner.friend')}</label>
      <label><input type="radio" name="owner" value="borrowed"> ${t('owner.borrowed')}</label></p>
      <label class="friend-name" hidden>${t('owner.name')} <input name="friend_name" maxlength="80" placeholder="${esc(t('owner.name_ph'))}"></label></form>
    <p class="note">${t('mybooks.add_how')}</p>
    <p class="muted small">💡 ${t('mybooks.add_tips')}</p>
    <div class="shots" id="capture-panel" hidden></div>
    <p id="queue-link"></p>
  </section>`;
  const queueLink = root.querySelector('#queue-link');
  const showQueue = () => queueCount({ maxAge: 0 }).then((c) => {
    queueLink.innerHTML = c.open + c.later || c.processing ? `<a class="btn" href="/queue">📥 ${t('queue.link', c)}</a>` : '';
  }).catch(() => {});
  showQueue();
  // Whose books: mine, or a friend's (catalogued at their home, to send them later).
  const pick = root.querySelector('.owner-pick');
  pick.onchange = () => { pick.querySelector('.friend-name').hidden = pick.owner.value === 'mine'; };
  const request = () => ({ owner: pick.owner.value, friend_name: pick.owner.value === 'mine' ? null : pick.friend_name.value.trim() || null, lang: lang() });
  root.querySelector('#files').onchange = async (e) => {
    const n = await captureFiles(e.target.files, request);
    e.target.value = '';
    if (n) { toast(t('capture.sent', { n })); showQueue(); }
  };
  const cam = captureShots({ screen: 'home', panel: root.querySelector('#capture-panel'), request, onEnd: showQueue });
  root.querySelector('#capture').onclick = async () => {
    if (!await cam.start()) root.querySelector('#files').click();
  };
  return () => { cam.stop(false); };
}
