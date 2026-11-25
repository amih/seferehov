import { scrollToY } from '../frame.js';
import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, nextLook } from '../ui.js';
import { t } from '../i18n.js';
import { ownerLabel } from '../mybooks.js';
import { todoTabs, setQueueCount } from '../todo.js';
import { stepsBox, attachSteps } from '../steps.js';
import { learnHome } from '../hints.js';

// Photos from the map's camera: where the server thinks they were taken, how sure it is and why
// (server/src/situation.js). ask: the reader answers before the books; else a line with "Change".
function situationHtml(sit, ask, open) {
  const g = sit.guess ?? {};
  const c = g.confidence ?? 0;
  const level = c >= 75 ? 'high' : c >= 45 ? 'mid' : 'low';
  const mark = { high: '🟢', mid: '🟡', low: '🔴' }[level];
  const title = g.kind === 'home' ? `🏠 ${t('sit.home')}` : g.kind === 'library' ? `📍 ${esc(t('sit.library', { name: g.location?.name || t('free_library') }))}` : `➕ ${t('sit.new_library')}`;
  const why = (g.why ?? []).slice(0, 4).map((w) => esc(t(`sit.why.${w.k}`, { v: w.v }))).filter(Boolean).join(' · ');
  const head = `<h2>${ask ? `${t('sit.ask', { n: sit.n })}<br>` : ''}${title}</h2>
    <p class="small why"><span aria-hidden="true">${mark}</span> ${c}%${why ? ` · ${why}` : ''}</p>`;
  if (!ask && !open) return `<div class="sit sure">${head}<button class="btn small" data-sit-open>${t('sit.change')}</button></div>`;
  const libs = (g.candidates ?? []).filter((l) => g.kind !== 'library' || l.code !== g.location?.code);
  const opts = [
    g.kind !== 'new_library' && ask ? `<button class="btn primary" data-sit="right">✓ ${t('sit.right')}</button>` : '',
    g.kind === 'new_library' ? `<button class="btn primary" data-sit="new_library">✓ ${t('sit.yes_new')}</button>` : '',
    ...libs.map((l) => `<button class="btn" data-sit="library" data-code="${esc(l.code)}">📍 ${esc(l.name || t('free_library'))} (${l.m} ${t('sit.m')})</button>`),
    g.kind !== 'new_library' ? `<button class="btn" data-sit="new_library">➕ ${t('sit.opt_new')}</button>` : '',
    g.kind !== 'home' ? `<button class="btn" data-sit="home">🏠 ${t('sit.opt_home')}</button>` : '',
    `<button class="btn" data-sit="friend">👥 ${t('sit.opt_friend')}</button>`,
  ].filter(Boolean).join('');
  return `<div class="sit ${ask ? 'ask' : 'sure'}" data-session="${esc(sit.session)}">${head}
    ${ask ? '' : `<p class="small">${t('sit.change_how')}</p>`}
    <div class="opts">${opts}</div>
    <input name="sit-name" dir="auto" maxlength="120" placeholder="${esc(t('sit.new_name'))}" ${g.kind === 'new_library' ? '' : 'hidden'}>
    <input name="sit-friend" dir="auto" maxlength="80" placeholder="${esc(t('sit.friend_name'))}" hidden></div>`;
}

// Books waiting for the reader's approval, from all their photos, videos and barcodes:
// one at a time, with a large picture. Approve, decline, or set aside for later. The last
// decision can be undone at once, and the last two weeks' from "Recent decisions": the
// book comes back to the front of the queue, to be fixed and approved again.
// How sure the server is of this book (the queue shows the surest first): a coloured
// mark, the percentage and the main reason.
function confidenceLine(i) {
  const c = i.confidence ?? 0;
  const level = c >= 75 ? 'high' : c >= 45 ? 'mid' : 'low';
  const mark = { high: '🟢', mid: '🟡', low: '🔴' }[level];
  return `<p class="small conf conf-${level}" title="${esc(t('conf.title'))}"><span aria-hidden="true">${mark}</span> ${t(`conf.${level}`)} · ${c}% · ${esc(t(`conf.why.${i.confidence_why}`) || i.confidence_why || '')}</p>`;
}

export default async function queueView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/queue', { replace: true });

  let items = [];
  let counts = { open: 0, later: 0, processing: 0 };
  let processing = [];
  let situations = [];
  let sitOpen = false; // "Change" pressed on a sure guess
  const skipped = new Set(); // set aside in this visit: not shown again until the next one
  let current = null;
  let timer = null;
  let stopped = false;
  let lastDone = null; // { id, title, decision }: the "undo" line above the next book
  let readyAt = 0; // taps on a book just shown are ignored for a moment: they were meant for the one before

  async function load() {
    const r = await api('/api/queue');
    items = r.items;
    processing = r.processing;
    situations = r.situations ?? [];
    counts = r;
    setQueueCount(r);
  }
  const next = () => items.find((i) => !skipped.has(i.id));

  // While photos are still being read, look again now and then: new books take their place by confidence.
  // 8 s at first, then longer (up to a minute), only while in view; back to 8 s when new
  // books came in.
  let looks = 0;
  async function poll() {
    if (stopped || !counts.processing || timer) return;
    timer = true;
    await nextLook(looks++);
    timer = null;
    if (stopped) return;
    const before = items.length;
    try { await load(); } catch { /* offline: try later */ }
    if (items.length !== before) looks = 0;
    if (current) renderHeader(); else render();
    poll();
  }

  function header() {
    const busy = processing.length
      ? `<p class="progress-line small"><span class="spinner"></span> ${t('queue.processing', { n: processing.length })}${counts.wait ? ` ${t('queue.wait', { mins: counts.wait })}` : ''}</p>` : '';
    const done = lastDone
      ? `<p class="undo-line">${esc(t(`queue.just_${lastDone.decision}`, { title: lastDone.title }))} <button class="btn small" data-undo="${lastDone.id}">${t('queue.undo')}</button></p>` : '';
    // Three groups, so the reader sees the app working for them and knows what is optional (Ami,
    // 24 Nov 2026): high = approved for them (last 3 days), medium = wait for them, low = optional.
    const open = items.filter((i) => !skipped.has(i.id));
    const low = open.filter((i) => (i.confidence ?? 0) < 45).length;
    const rows = [
      counts.auto ? t('queue.sum_auto_html', { n: counts.auto }) : '',
      open.length - low ? t('queue.sum_mid_html', { n: open.length - low }) : '',
      low ? t('queue.sum_low_html', { n: low }) : '',
    ].filter(Boolean);
    const sum = rows.length ? `<ul class="queue-sum">${rows.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
    return `${done}${sum}${busy}`;
  }
  const recentLink = () => `<p class="row"><button class="btn small" id="recent">${t('queue.recent')}</button>${counts.hidden ? ` <button class="btn small" id="show-hidden">${t('queue.show_hidden', { n: counts.hidden })}</button>` : ''}</p>`;

  async function undo(id) {
    try {
      const r = await api(`/api/queue/${id}/undo`, { method: 'POST', json: {} });
      counts = { ...counts, ...r };
      setQueueCount(counts);
      items = [r.item, ...items.filter((x) => x.id !== r.item.id)];
      skipped.delete(r.item.id);
      lastDone = null;
      toast(t('queue.undone'));
      render();
      scrollToY(0);
    } catch (err) { toast(err.message); }
  }

  async function renderRecent() {
    current = null;
    root.innerHTML = `<section class="page"><h1>${t('queue.recent_title')}</h1><p class="muted">${t('loading')}</p></section>`;
    let list = [];
    try { list = (await api('/api/queue/recent')).items; } catch (err) { toast(err.message); }
    root.innerHTML = `
    <section class="page recent">
      <p><button class="btn small" id="back">${t('queue.back_to_queue')}</button></p>
      <h1>${t('queue.recent_title')}</h1>
      <p class="muted small">${t('queue.recent_how')}</p>
      ${list.length ? `<ul class="recent-list">${list.map((i) => `<li>
        ${i.pic ? `<img src="${esc(i.pic)}" alt="">` : '<span class="nopic">📕</span>'}
        <div><b dir="auto">${esc(i.title)}</b>${i.authors?.length ? `<br><span class="small" dir="auto">${esc(i.authors.join(', '))}</span>` : ''}
          <br><span class="small muted">${t(`queue.was_${i.decision}`)}${i.helped ? ` (${t('hc.by_helpers')})` : ''} · ${i.code ? esc(i.location_name || t('free_library')) : t('queue.my_books')}</span></div>
        ${i.undoable ? `<button class="btn small" data-undo="${i.id}">${t('queue.undo')}</button>` : `<span class="small muted">${t('queue.placed')}</span>`}
      </li>`).join('')}</ul>` : `<p class="note">${t('queue.recent_none')}</p>`}
    </section>`;
    root.querySelector('#back').onclick = () => { render(); scrollToY(0); };
  }
  root.addEventListener('click', (e) => {
    const u = e.target.closest('[data-undo]');
    if (u) { u.disabled = true; undo(Number(u.dataset.undo)); }
    else if (e.target.closest('#recent')) { renderRecent(); scrollToY(0); }
    else if (e.target.closest('#show-hidden')) { api('/api/queue/skipped/show', { method: 'POST' }).then(() => location.reload()).catch(() => toast(t('offline'))); }
  });
  function renderHeader() {
    const h = root.querySelector('#qhead');
    if (h) h.innerHTML = header();
  }

  const sitOf = (i) => (i?.situation ? situations.find((x) => x.session === i.session) : null);

  // The reader's answer to "where were these taken?" (or the sure guess changed).
  async function answerSituation(sit, body) {
    try {
      const r = await api(`/api/captures/${sit.session}/situation`, { method: 'POST', json: body });
      if (r.kind === 'home') learnHome(sit.session);
      sitOpen = false;
      toast(t('sit.thanks'));
      await load();
      render();
      scrollToY(0);
    } catch (err) {
      toast(err.body?.error === 'already_approved' ? t('sit.already') : err.body?.error === 'nearby_exists' ? t('sit.nearby', { name: err.body?.location?.name || t('free_library') })
        : err.body?.error === 'location_required' ? t('sit.need_place') : err.message);
      root.querySelectorAll('[data-sit]').forEach((x) => { x.disabled = false; });
    }
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-sit-open]')) { sitOpen = true; render(); return; }
    const b = e.target.closest('[data-sit]');
    const box = b?.closest('.sit');
    const sit = box && situations.find((x) => x.session === box.dataset.session);
    if (!sit) return;
    const kind = b.dataset.sit;
    const name = box.querySelector('[name=sit-name]'), friend = box.querySelector('[name=sit-friend]');
    if (kind === 'new_library' && name.hidden) { name.hidden = false; name.focus(); return; }
    if (kind === 'friend' && friend.hidden) { friend.hidden = false; friend.focus(); return; }
    b.disabled = true;
    answerSituation(sit, { kind, code: b.dataset.code, name: name.value.trim() || undefined, friend_name: friend.value.trim() || undefined });
  });

  function render() {
    current = next();
    // From the map's camera, unsure where: the question comes before its books.
    const ask = current?.situation === 'ask' ? sitOf(current) : null;
    if (ask) {
      root.innerHTML = `
      <section class="page">
        ${todoTabs('mine')}
        <h1>${t('queue.title')}</h1>
        <div id="qhead">${header()}</div>
        ${situationHtml(ask, true, true)}
        ${recentLink()}
      </section>`;
      return;
    }
    if (!current) {
      root.innerHTML = `
      <section class="page">
        ${todoTabs('mine')}
        <h1>${t('queue.title')}</h1>
        <div id="qhead">${header()}</div>
        <p class="note">${counts.processing ? t('queue.wait_more') : skipped.size ? t('queue.only_later', { n: skipped.size }) : t('queue.empty')}</p>
        <p class="row">${skipped.size ? `<button class="btn" id="again">${t('queue.again')}</button>` : ''}<a class="btn" href="/">${t('back.map')}</a></p>
        ${recentLink()}
      </section>`;
      root.querySelector('#again')?.addEventListener('click', () => { skipped.clear(); render(); });
      return;
    }
    const i = current;
    const shownTitle = i.matched ? i.book_title : i.title;
    const shownAuthor = i.matched ? (i.book_authors ?? []).join(', ') : (i.author ?? '');
    const big = i.crop || i.frame || i.cover_url;
    root.innerHTML = `
    <section class="page approve">
      ${todoTabs('mine')}
      <h1>${t('queue.title')}</h1>
      <div id="qhead">${header()}</div>
      ${sitOf(i) ? situationHtml(sitOf(i), false, sitOpen) : ''}
      <p class="muted small">${(i.sources?.length ? i.sources : [i.source]).map((x) => esc(t(`queue.from_${x}`))).join(' + ')} · ${i.code ? `<a href="/l/${i.code}">${esc(i.location_name || t('free_library'))}</a>` : `<a href="/books">${t('queue.my_books')}</a>${i.owner && i.owner !== 'mine' ? ` · ${ownerLabel(i)}` : ''}`}${i.decision === 'later' ? ` · ${t('queue.was_later')}` : ''}</p>
      ${big ? `<a href="${esc(i.frame || big)}" target="_blank" class="big-pic ${i.crop ? 'crop' : ''}"><img src="${esc(big)}" alt="${t('scan.photo_of')}"></a>` : ''}
      <div class="approve-book">
        ${i.cover_url && big !== i.cover_url ? `<img class="cover" src="${esc(i.cover_url)}" alt="">` : ''}
        <form class="form" id="f">
          <label>${t('field.title')} <input name="title" dir="auto" value="${esc(shownTitle)}" maxlength="300" required></label>
          <label>${t('field.author')} <input name="author" dir="auto" value="${esc(shownAuthor)}" maxlength="200"></label>
          <p class="small qline q-${i.quality}">${i.quality === 'high' ? `✓ ${t('scan.matched')}${i.year ? ` · ${i.year}` : ''}` : i.quality === 'low' ? `⚠ ${t('scan.lowq')}` : `? ${t('scan.unmatched')}`}</p>
          ${confidenceLine(i)}
        </form>
      </div>
      ${i.back ? `<a href="${esc(i.back)}" target="_blank" class="big-pic back-pic"><img src="${esc(i.back)}" alt="${t('queue.back_cover')}"></a>` : ''}
      ${i.crop && i.frame ? `<p><a class="small" href="${esc(i.frame)}" target="_blank">${t('queue.whole_photo')}</a></p>` : ''}
      ${i.crop && i.crop_hidden ? `<p class="note small">${t('queue.crop_hidden')}</p>` : ''}
      ${i.code && !i.book_id && ['photo', 'video'].includes(i.source) ? `<p class="note small">${t('check.queue_hint')} <a href="/l/${i.code}/check">🔎 ${t('check.title')}</a></p>` : ''}
      <div class="decide${i.crop ? ' six' : ''}">
        <button class="btn primary" data-d="approved">✓ ${t('queue.approve')}</button>
        ${i.crop ? `<button class="btn primary" data-d="approved" data-flip="1" title="${esc(t('queue.approve_flip_title'))}">✓ 🙃 ${t('queue.approve_flip')}</button>
        <button class="btn primary" data-d="approved" data-across="1" title="${esc(t('queue.approve_across_title'))}">✓ ↔ ${t('queue.approve_across')}</button>` : ''}
        <button class="btn" data-d="later">⏸ ${t('queue.later')}</button>
        ${i.crop ? `<button class="btn danger" data-d="declined" data-why="reading" title="${esc(t('queue.decline_reading_title'))}">✕ ${t('queue.decline_reading')}</button>
        <button class="btn danger" data-d="declined" data-why="cutout" title="${esc(t('queue.decline_cutout_title'))}">✕ ${t('queue.decline_cutout')}</button>`
    : `<button class="btn danger" data-d="declined">✕ ${t('queue.decline')}</button>`}
      </div>
      <p class="muted small">${t('queue.helps')}</p>
      ${counts.help_days && i.code && ['photo', 'video'].includes(i.source) ? `<p class="muted small">${t('hc.owner_note', { days: counts.help_days })}</p>` : ''}
      ${stepsBox(i.id)}
      ${recentLink()}
    </section>`;
    readyAt = Date.now() + 700;
    attachSteps(root);

    const form = root.querySelector('#f');
    root.querySelector('.decide').onclick = async (e) => {
      const b = e.target.closest('[data-d]');
      if (!b || Date.now() < readyAt) return;
      const decision = b.dataset.d;
      const body = { decision };
      if (b.dataset.flip) body.flip = true;
      if (b.dataset.across) body.across = true;
      if (b.dataset.why) body.why = b.dataset.why;
      if (decision === 'approved') {
        const title = form.title.value.trim();
        const author = form.author.value.trim();
        if (!title) return form.title.focus();
        // Only a correction is sent: unchanged catalogue matches keep their record.
        if (title !== shownTitle || author !== shownAuthor) Object.assign(body, { title, author });
      }
      root.querySelectorAll('.decide button').forEach((x) => { x.disabled = true; });
      try {
        const r = await api(`/api/queue/${i.id}`, { method: 'POST', json: body });
        // Approving a book of a sure guess accepted the guess (server/src/approvals.js).
        if (decision === 'approved' && i.situation === 'sure') {
          if (sitOf(i)?.guess?.kind === 'home') learnHome(i.session);
          await load().catch(() => {});
        }
        counts = { ...counts, ...r };
        setQueueCount(counts);
        if (decision === 'later') skipped.add(i.id);
        else items = items.filter((x) => x.id !== i.id);
        lastDone = decision === 'later' ? null : { id: i.id, decision: body.flip ? 'flipped' : decision, title: body.title || shownTitle };
        if (decision === 'approved' && r.status === 'pending') toast(t('loc.thanks_review'));
        render();
        scrollToY(0);
      } catch (err) {
        if (err.body?.error === 'situation_first') { await load().catch(() => {}); render(); return; }
        toast(err.message);
        root.querySelectorAll('.decide button').forEach((x) => { x.disabled = false; });
      }
    };
  }

  root.innerHTML = `<section class="page"><p class="muted">${t('loading')}</p></section>`;
  try { await load(); } catch (e) {
    root.innerHTML = `<section class="page"><p class="note">${t('offline')}</p></section>`;
    return;
  }
  render();
  poll();
  return () => { stopped = true; };
}
