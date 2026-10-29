import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, confirmDialog } from '../ui.js';
import { lang } from '../i18n.js';
import { tracked } from '../analytics.js';
import { todoTabs } from '../todo.js';

// For the admin only (English): the public pages search engines see, cover texts that
// wait for a check, readers' reviews (to hide one), how the app is used (counts) with
// Matomo's visitor numbers, and the readers one by one.
const TABS = [['pages', 'Search pages'], ['texts', 'Cover texts'], ['reviews', 'Reviews'], ['stats', 'Activity'], ['readers', 'Readers'], ['camera', 'Camera']];

export default async function adminView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/admin', { replace: true });
  if (me.trust_level < 3) { root.innerHTML = '<section class="page"><h1>Admins only</h1></section>'; return; }
  let tab = location.hash.slice(1) || 'pages';
  let data = null;

  root.innerHTML = `<section class="page admin" dir="ltr" lang="en">
    <div dir="auto" lang="${lang()}">${todoTabs('texts')}</div>
    <h1>Admin</h1>
    <p><a class="btn small" href="/admin/trace">🔬 Traces: every AI stage of each scan</a></p>
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

  // Live-camera sessions: the phone (model · system · browser), where the time went
  // (holding, moving on, too fast, too dark, glare, waiting for the barcode), the photos
  // and how each was taken, the median time from "ready" to the photo, books (front →
  // back) and how fast the phone moved (shelf: px of a 160-px-wide copy per 0.15 s tick;
  // bucket tops 0.5 1 1.5 2 2.5 3 4 6 10, last = faster / lost). Below: each upload from
  // the outbox (waited on the phone, upload time, server time). Full numbers under "…".
  async function camera() {
    const { sessions, uploads } = await api('/api/admin/camera-sessions');
    const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
    const share = (st, k) => (st.ms && st.states?.[k] ? `${Math.round((100 * st.states[k]) / st.ms)}%` : '—');
    const tops = [0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10];
    const median = (hist) => {
      const n = hist.reduce((a, b) => a + b, 0);
      let c = 0;
      for (let i = 0; i < hist.length; i++) if ((c += hist[i]) >= n / 2) return i < tops.length ? `<${tops[i]}` : '>10';
      return '—';
    };
    const mid = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
    const when = (d) => esc(new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    // Model · system · browser, from userAgentData (Android Chrome) or the user agent string (iPhone, others).
    const phone = (d, ua) => {
      const u = d?.uaData, s = d?.ua ?? ua ?? '';
      const model = u?.model || (/iPhone|iPad/.exec(s)?.[0]) || (/Android [\d.]+; ([^;)]+)/.exec(s)?.[1]) || '';
      const os = u?.platform ? `${u.platform} ${u.platformVersion ?? ''}`.trim()
        : /OS ([\d_]+) like Mac/.test(s) ? `iOS ${/OS ([\d_]+)/.exec(s)[1].replace(/_/g, '.')}` : (/Android [\d.]+/.exec(s)?.[0] ?? (/Windows|Mac OS X|Linux/.exec(s)?.[0] ?? ''));
      const m = /(CriOS|FxiOS|EdgA|SamsungBrowser|Firefox|Chrome|Version)\/([\d.]+)/.exec(s);
      const br = u?.fullVersionList?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)) ?? (m && { brand: m[1].replace('Version', 'Safari'), version: m[2] });
      return [model, os, br ? `${br.brand} ${br.version.split('.')[0]}` : ''].filter(Boolean).join(' · ') || '?';
    };
    const kb = (b) => (b == null ? '—' : `${Math.round(b / 1024)} KB`);
    return `<p>Each time a live camera was used (no pictures, only numbers). Hold = waiting for the phone to steady at new books, next = moving on after a photo,
      hunt = waiting for a barcode close-up, wait = animation / settling. Photos: shelf steady / rough / leaving; covers still (2 still ticks) / best (sharpest of a
      moment) / button / file (camera app). Ready → photo = median time from the moment a photo could be taken to the photo.</p>
      ${sessions.length ? table(['When', 'Reader', 'Phone', 'Kind', 'Camera', 'Open', 'Time', 'Photos', 'Ready → photo', 'Books (front→back)', 'Codes', 'Hold', 'Next', 'Too fast', 'Dark', 'Glare', 'Speed (median)', 'Ended', ''], sessions.map((c) => {
        const st = c.stats, ph = st.photos ?? [], by = (h) => ph.filter((p) => p.how === h).length, bk = st.books ?? [];
        const hows = [...new Set(ph.map((p) => p.how))].map((h) => `${h} ${by(h)}`).join(' / ');
        const codes = (st.events ?? []).filter((e) => e.e === 'code').length + bk.filter((b) => b.code === 'still').length;
        const set = c.camera?.settings;
        return [when(c.created_at),
          c.user_id ? `<a href="/r/${c.user_id}">${esc(c.screen_name ?? `#${c.user_id}`)}</a>` : '—',
          esc(phone(c.device, c.ua)),
          esc(`${c.kind} · ${st.screen ?? st.detector ?? ''}`),
          esc(set ? `${set.width}×${set.height}${set.frameRate ? ` @${Math.round(set.frameRate)}` : ''}` : st.cam ?? '—'),
          st.openError ? `<b>${esc(st.openError)}</b>` : sec(st.openMs),
          sec(st.ms ?? 0), `<b>${ph.length}</b> <span class="muted small">${esc(hows)}</span>`,
          sec(mid(ph.map((p) => p.wait))),
          bk.length ? `${bk.length} <span class="muted small">(${sec(mid(bk.map((b) => b.frontToBack)))})</span>` : '—',
          codes || '—',
          share(st, 'hold'), share(st, 'next'), share(st, 'fast'), share(st, 'dark'), share(st, 'glare'), st.ticks ? median(st.speed) : '—', esc(st.ended ?? ''),
          `<details><summary>…</summary><pre class="small">${esc(JSON.stringify({ ...st, device: c.device, camera: c.camera, ua: c.ua }, null, 1))}</pre></details>`];
      })) : '<p class="note">No camera sessions yet.</p>'}
      <h2>Uploads</h2>
      <p>Each try of an upload from the phone's outbox. On phone = stored on the phone → sent (no signal, batch still being taken);
        upload = sent → answer, on the phone; server = handling time.</p>
      ${uploads?.length ? table(['When', 'Reader', 'What', 'Size', 'On phone', 'Upload', 'Server', 'Try', 'Net', 'Status', 'Became'], uploads.map((u) => [
        when(u.created_at), esc(u.screen_name ?? '—'), esc(`${u.label ?? ''} · ${u.files ?? 0} files`), kb(u.bytes),
        sec(u.queued_ms), sec(u.client_ms), sec(u.server_ms), u.tries + 1, esc(`${u.sender ?? ''} ${u.net ?? ''}`), u.status,
        esc(u.result ? Object.entries(u.result).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ') : '')]))
        : '<p class="note">No uploads timed yet.</p>'}`;
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
      <p class="muted small">Newest first. "Last in": last visit while signed in, or last report. Points: all time (this week). ▸ shows what a reader did.</p>
      ${table(['Reader', 'Joined', 'Last in', 'Points', 'Scans', 'Reports', 'At home', 'Reviews', 'Libraries', 'Alerts', '📱'], readers.map((r) => [
        `<button class="link small" data-activity="${r.id}" aria-label="Activity">▸</button> <a href="/r/${r.id}" dir="auto">${esc(r.screen_name || '(no name yet)')}</a><br><span class="muted small">${esc(r.email)}${r.google ? ' · G' : ''}${r.trust_level ? ` · ${LEVEL[r.trust_level]}` : ''}</span>`,
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
      if (tab === 'camera') { body.innerHTML = await camera(); return; }
      data ??= await api('/api/admin/overview');
      body.innerHTML = tab === 'stats' ? stats() : pages();
    } catch (e) {
      body.innerHTML = `<p class="note">${esc(e.message)}</p>`;
    }
  }

  // A reader's own actions, in a row under theirs.
  async function toggleActivity(btn) {
    const tr = btn.closest('tr');
    if (tr.nextElementSibling?.classList.contains('activity-row')) { tr.nextElementSibling.remove(); btn.textContent = '▸'; return; }
    btn.textContent = '▾';
    const row = document.createElement('tr');
    row.className = 'activity-row';
    row.innerHTML = `<td colspan="11"><p class="muted small">Loading…</p></td>`;
    tr.after(row);
    try {
      const { activity } = await api(`/api/admin/readers/${btn.dataset.activity}`);
      row.firstElementChild.innerHTML = activity.length ? `<ul class="activity-list">${activity.map((a) => `<li><span class="muted small">${esc(new Date(a.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        <b>${esc(a.what)}</b>${a.detail ? ` <span class="muted small">${esc(a.detail)}</span>` : ''}
        ${a.book_id ? ` · <a href="/b/${a.book_id}" dir="auto">${esc(a.title ?? `#${a.book_id}`)}</a>` : ''}
        ${a.code ? ` · <a href="/l/${esc(a.code)}" dir="auto">${esc(a.place || a.code)}</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nothing yet.</p>';
      row.firstElementChild.insertAdjacentHTML('beforeend', `<p><button class="btn small danger" data-revert-fixes="${btn.dataset.activity}">↩ Undo all this reader's book fixes</button></p>`);
    } catch (err) { row.firstElementChild.innerHTML = `<p class="note">${esc(err.message)}</p>`; }
  }

  body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-activity]');
    if (act) { toggleActivity(act); return; }
    const rf = e.target.closest('[data-revert-fixes]');
    if (rf) {
      if (!await confirmDialog('Undo every live book fix by this reader and reject their waiting ones?', 'Undo all')) return;
      rf.disabled = true;
      await api(`/api/admin/readers/${rf.dataset.revertFixes}/revert-fixes`, { method: 'POST', json: {} })
        .then((r) => toast(`${r.undone} undone, ${r.rejected} rejected`), (err) => { toast(err.message); rf.disabled = false; });
      return;
    }
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
