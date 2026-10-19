import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast } from '../ui.js';
import { lang } from '../i18n.js';
import { tracked } from '../analytics.js';
import { todoTabs } from '../todo.js';

// For the admin only (English): the public pages search engines see, cover texts that
// wait for a check, readers' reviews (to hide one), how the app is used (counts) with
// Matomo's visitor numbers, and the readers one by one.
const TABS = [['pages', 'Search pages'], ['texts', 'Cover texts'], ['reviews', 'Reviews'], ['stats', 'Activity'], ['readers', 'Readers']];

export default async function adminView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/admin', { replace: true });
  if (me.trust_level < 3) { root.innerHTML = '<section class="page"><h1>Admins only</h1></section>'; return; }
  let tab = location.hash.slice(1) || 'pages';
  let data = null;

  root.innerHTML = `<section class="page admin" dir="ltr" lang="en">
    <div dir="auto" lang="${lang()}">${todoTabs('texts')}</div>
    <h1>Admin</h1>
    <div class="seg" id="tabs">${TABS.map(([k, label]) => `<button data-k="${k}">${label}</button>`).join('')}</div>
    <div id="body"><p class="muted">Loading…</p></div></section>`;
  const body = root.querySelector('#body');
  root.querySelector('#tabs').onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    tab = b.dataset.k;
    history.replaceState(history.state, '', `#${tab}`);
    show();
  };

  const n = (x) => Number(x ?? 0).toLocaleString('en');
  const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const country = (cc) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { return cc; } };
  const he = lang() === 'he';
  const table = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  function pages() {
    const s = data.seo;
    return `<p>Everything here is in the <a href="${esc(s.sitemap)}" target="_blank">sitemap</a>. Pages render from the live database; ?lang=en gives the English version.</p>
      <div class="stat-row">${[['Countries', s.counts.countries], ['Towns', s.counts.places], ['Libraries', s.counts.libraries], ['Books', s.counts.books]]
        .map(([k, v]) => `<div class="stat"><b>${n(v)}</b><span>${k}</span></div>`).join('')}</div>
      <details open><summary><h2>Books (${n(s.counts.books)})</h2></summary>
        ${table(['Book', 'Code', 'Covers', 'Blurb', 'Cover text', 'Updated'], s.books.map((b) => [
          `<a href="${esc(b.path)}" dir="auto">${esc(b.title)}</a><br><span class="muted small" dir="auto">${esc((b.authors ?? []).join(', '))}</span>`,
          b.isbn13 ? `ISBN ${b.isbn13}` : b.danacode ? `Danacode ${b.danacode}` : '—',
          b.catalog_cover ? '✓' : '—', b.blurb ? '✓' : '—', b.texts ? `✓ ${b.texts}` : '—', b.lastmod ? day(b.lastmod) : '']))}</details>
      <details><summary><h2>Libraries with books or added by readers (${n(s.libraries.length)})</h2></summary>
        ${table(['Library', 'Town', 'Books', 'Last report'], s.libraries.map((l) => [
          `<a href="/l/${l.code}" dir="auto">${esc(l.name || l.code)}</a>`, esc((he && l.place_he) || l.place || ''), n(l.books), l.last_report ? day(l.last_report) : '—']))}</details>
      <details><summary><h2>Towns (${n(s.counts.places)}, top ${s.places.length})</h2></summary>
        ${table(['Town', 'Country', 'Libraries'], s.places.map((p) => [
          `<a href="/p/${p.id}-${p.slug}">${esc(p.name)}</a>${p.name_he ? ` <span dir="rtl">${esc(p.name_he)}</span>` : ''}`, esc(country(p.country)), n(p.n)]))}</details>
      <details><summary><h2>Countries (${n(s.counts.countries)})</h2></summary>
        ${table(['Country', 'Libraries'], s.countries.map((c) => [`<a href="/c/${c.cc.toLowerCase()}">${esc(country(c.cc))}</a>`, n(c.n)]))}</details>`;
  }

  async function texts() {
    const d = await api('/api/admin/cover-texts');
    return `<p>Text read from cover photos. English and other Latin-script covers are shown on the book page at once;
      Hebrew reads are rough, so they wait here. Fix the text if needed, then approve, or reject.</p>
      <p class="muted small">Shown: ${n(d.counts.shown)} · waiting for a check: ${n(d.counts.review)} · not read yet: ${n(d.counts.waiting)} (read when no shelf photos are waiting)</p>
      ${d.items.length ? d.items.map((i) => `<div class="card ocr-item" data-id="${i.id}">
        <a href="/uploads/${esc(i.path)}" target="_blank"><img src="/uploads/${esc(i.path)}" alt=""></a>
        <div><p>${i.book_id ? `<a href="/b/${i.book_id}" dir="auto">${esc(i.title)}</a>` : '<span class="muted">(no book)</span>'} · ${i.kind === 'back' ? 'back' : 'front'}</p>
          <textarea dir="auto" rows="10">${esc(i.ocr_text)}</textarea>
          <p class="row"><button class="btn primary" data-s="approved">✓ Approve</button><button class="btn danger" data-s="rejected">✕ Reject</button></p></div></div>`).join('')
        : '<p class="note">Nothing waits for a check.</p>'}`;
  }

  async function reviews() {
    const d = await api('/api/admin/reviews');
    const q = { summary: 'In one sentence', liked: 'Liked', recommend_to: 'Recommend to', when: 'When' };
    return `<p>Newest written reviews. They are public at once; hide one that should not be.</p>
      ${d.reviews.length ? d.reviews.map((r) => `<div class="card review-admin${r.hidden ? ' muted' : ''}" data-review="${r.id}">
        <p><a href="/b/${r.book_id}" dir="auto">${esc(r.title)}</a> · <a href="/r/${r.user_id}">${esc(r.screen_name)}</a>
          ${r.rating ? '★'.repeat(r.rating) : ''} · ${day(r.updated_at)}${r.hidden ? ' · <b>hidden</b>' : ''}</p>
        ${Object.entries(r.answers).map(([k, v]) => `<p dir="auto"><span class="muted small">${q[k] ?? k}:</span> ${esc(v)}</p>`).join('')}
        <p><button class="btn small" data-hide="${r.hidden ? '0' : '1'}">${r.hidden ? 'Show again' : 'Hide'}</button></p></div>`).join('')
        : '<p class="note">No written reviews yet.</p>'}`;
  }

  async function readersTab() {
    const { readers } = await api('/api/admin/readers');
    const ago = (d) => {
      if (!d) return '—';
      const m = (Date.now() - new Date(d)) / 60000;
      return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : m < 2880 ? 'yesterday' : day(d);
    };
    const since = (d, days) => d && Date.now() - new Date(d) < days * 864e5;
    const count = (f) => readers.filter(f).length;
    const LEVEL = ['new', 'trusted', 'reviewer', 'admin'];
    return `<div class="stat-row">${[['Readers', readers.length], ['Joined in 7 days', count((r) => since(r.created_at, 7))],
      ['In today', count((r) => since(r.last_seen, 1))], ['In this week', count((r) => since(r.last_seen, 7))],
      ['Did something', count((r) => r.scans + r.reports + r.home_books + r.reviews)], ['Phone alerts on', count((r) => r.phones)]]
        .map(([k, v]) => `<div class="stat"><b>${n(v)}</b><span>${k}</span></div>`).join('')}</div>
      <p class="muted small">Newest first. "Last in": last visit while signed in, or last report. Points: all time (this week).</p>
      ${table(['Reader', 'Joined', 'Last in', 'Points', 'Scans', 'Reports', 'At home', 'Reviews', 'Libraries', 'Alerts', '📱'], readers.map((r) => [
        `<a href="/r/${r.id}" dir="auto">${esc(r.screen_name || '(no name yet)')}</a><br><span class="muted small">${esc(r.email)}${r.google ? ' · G' : ''}${r.trust_level ? ` · ${LEVEL[r.trust_level]}` : ''}</span>`,
        day(r.created_at), ago(r.last_seen), `${n(r.karma)}${r.week_points ? ` <span class="muted small">(+${n(r.week_points)})</span>` : ''}`,
        n(r.scans), n(r.reports), n(r.home_books), n(r.reviews), n(r.libraries), n(r.watches), r.phones ? '✓' : '']))}`;
  }

  function stats() {
    const a = data.activity, m = data.matomo;
    const sum = (k) => a.daily.reduce((s, d) => s + d[k], 0);
    const max = Math.max(1, ...a.daily.map((d) => d.reports + d.home_books));
    const visits = m && !m.error ? m.days : [];
    const vmax = Math.max(1, ...visits.map((d) => d.visits));
    const bars = (rows, val, top, label) => `<div class="bars">${rows.map((r) => `<span title="${esc(label(r))}" style="height:${Math.round((val(r) / top) * 100)}%"></span>`).join('')}</div>`;
    return `<p class="muted small">Counts only — no one's own activity is shown. "Most reported" lists need three or more different readers.</p>
      <div class="stat-row">${[['Readers', a.totals.readers], ['Libraries', a.totals.libraries], ['Added by readers', a.totals.reader_libraries],
        ['Books in libraries', a.totals.books_in_libraries], ['Books at home', a.totals.books_at_home], ['Reports', a.totals.reports], ['Book alerts', a.totals.watches]]
        .map(([k, v]) => `<div class="stat"><b>${n(v)}</b><span>${k}</span></div>`).join('')}</div>
      <h2>Last 30 days</h2>
      <p>New readers ${n(sum('new_readers'))} · scans ${n(sum('scans'))} · book reports ${n(sum('reports'))} · books added at home ${n(sum('home_books'))} · new libraries ${n(sum('new_libraries'))}</p>
      <p class="muted small">Books reported + added at home, per day</p>
      ${bars(a.daily, (d) => d.reports + d.home_books, max, (d) => `${day(d.day)}: ${d.reports} reports, ${d.home_books} at home, ${d.active_readers} active readers`)}
      ${m?.error ? `<p class="note">Matomo: ${esc(m.error)}</p>` : m ? `
        <h2>Visitors (Matomo)</h2>
        <p>${n(visits.reduce((s, d) => s + d.visits, 0))} visits in 30 days${tracked() ? '' : ' · this device is not counted'}</p>
        ${bars(visits, (d) => d.visits, vmax, (d) => `${d.day}: ${d.visits} visits`)}
        <h3>Top pages</h3>${table(['Page', 'Views'], m.pages.map((p) => [esc(p.url), n(p.hits)]))}
        <h3>Where visitors came from</h3>${table(['Source', 'Visits'], m.referrers.map((r) => [esc(r.type), n(r.visits)]))}
        <h3>Countries</h3>${table(['Country', 'Visits'], m.countries.map((c) => [esc(c.country), n(c.visits)]))}`
        : '<p class="note">Matomo numbers: set MATOMO_URL, MATOMO_SITE_ID and MATOMO_TOKEN on the server.</p>'}
      <h2>How well photos are read</h2>
      ${table(['From', 'Books found', 'Kept as read', 'Fixed', 'Dropped', 'With ISBN/Danacode'], a.reading.map((r) => [esc(r.source), n(r.items), n(r.kept), n(r.edited), n(r.dropped), n(r.with_code)]))}
      ${a.topBooks.length ? `<h2>Most reported books</h2>${table(['Book', 'Reports'], a.topBooks.map((b) => [`<a href="${esc(b.path)}" dir="auto">${esc(b.title)}</a>`, n(b.n)]))}` : ''}
      ${a.topPlaces.length ? `<h2>Busiest towns</h2>${table(['Town', 'Reports'], a.topPlaces.map((p) => [`<a href="/p/${p.id}-${p.slug}">${esc(p.name)}</a>`, n(p.n)]))}` : ''}`;
  }

  async function show() {
    root.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === tab));
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (tab === 'texts') { body.innerHTML = await texts(); return; }
      if (tab === 'reviews') { body.innerHTML = await reviews(); return; }
      if (tab === 'readers') { body.innerHTML = await readersTab(); return; }
      data ??= await api('/api/admin/overview');
      body.innerHTML = tab === 'stats' ? stats() : pages();
    } catch (e) {
      body.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    }
  }

  body.addEventListener('click', async (e) => {
    const h = e.target.closest('[data-hide]');
    if (h) {
      await api(`/api/admin/reviews/${h.closest('[data-review]').dataset.review}`, { method: 'POST', json: { hidden: h.dataset.hide === '1' } })
        .then(show, (err) => toast(err.message));
      return;
    }
    const b = e.target.closest('[data-s]');
    const card = b?.closest('.ocr-item');
    if (!card) return;
    b.disabled = true;
    try {
      await api(`/api/admin/cover-texts/${card.dataset.id}`, { method: 'POST', json: { status: b.dataset.s, text: card.querySelector('textarea').value } });
      card.remove();
    } catch (err) { toast(err.message); b.disabled = false; }
  });
  show();
}
