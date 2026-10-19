import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast } from '../ui.js';
import { t } from '../i18n.js';
import { ownerLabel } from '../mybooks.js';

// Books waiting for the reader's approval, from all their photos, videos and barcodes:
// one at a time, with a large picture. Approve, decline, or set aside for later.
export default async function queueView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/queue', { replace: true });

  let items = [];
  let counts = { open: 0, later: 0, processing: 0 };
  let processing = [];
  const skipped = new Set(); // set aside in this visit: not shown again until the next one
  let current = null;
  let timer = null;
  let stopped = false;

  async function load() {
    const r = await api('/api/queue');
    items = r.items;
    processing = r.processing;
    counts = r;
  }
  const next = () => items.find((i) => !skipped.has(i.id));

  // While photos are still being read, look again now and then: new books join the end.
  function poll() {
    clearTimeout(timer);
    if (stopped || !counts.processing) return;
    timer = setTimeout(async () => {
      try { await load(); } catch { /* offline: try later */ }
      if (current) renderHeader(); else render();
      poll();
    }, 8000);
  }

  function header() {
    const left = items.filter((i) => !skipped.has(i.id)).length;
    const busy = processing.length
      ? `<p class="progress-line small"><span class="spinner"></span> ${t('queue.processing', { n: processing.length })}</p>` : '';
    return `${left ? `<p class="queue-count">${t('queue.left', { n: left })}</p>` : ''}${busy}`;
  }
  function renderHeader() {
    const h = root.querySelector('#qhead');
    if (h) h.innerHTML = header();
  }

  function render() {
    current = next();
    if (!current) {
      root.innerHTML = `
      <section class="page">
        <h1>${t('queue.title')}</h1>
        <div id="qhead">${header()}</div>
        <p class="note">${counts.processing ? t('queue.wait_more') : skipped.size ? t('queue.only_later', { n: skipped.size }) : t('queue.empty')}</p>
        <p class="row">${skipped.size ? `<button class="btn" id="again">${t('queue.again')}</button>` : ''}<a class="btn" href="/">${t('back.map')}</a></p>
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
      <h1>${t('queue.title')}</h1>
      <div id="qhead">${header()}</div>
      <p class="muted small">${(i.sources?.length ? i.sources : [i.source]).map((x) => esc(t(`queue.from_${x}`))).join(' + ')} · ${i.code ? `<a href="/l/${i.code}">${esc(i.location_name || t('free_library'))}</a>` : `<a href="/books">${t('queue.my_books')}</a>${i.owner && i.owner !== 'mine' ? ` · ${ownerLabel(i)}` : ''}`}${i.decision === 'later' ? ` · ${t('queue.was_later')}` : ''}</p>
      ${big ? `<a href="${esc(i.frame || big)}" target="_blank" class="big-pic ${i.crop ? 'crop' : ''}"><img src="${esc(big)}" alt="${t('scan.photo_of')}"></a>` : ''}
      <div class="approve-book">
        ${i.cover_url && big !== i.cover_url ? `<img class="cover" src="${esc(i.cover_url)}" alt="">` : ''}
        <form class="form" id="f">
          <label>${t('field.title')} <input name="title" dir="auto" value="${esc(shownTitle)}" maxlength="300" required></label>
          <label>${t('field.author')} <input name="author" dir="auto" value="${esc(shownAuthor)}" maxlength="200"></label>
          <p class="small qline q-${i.quality}">${i.quality === 'high' ? `✓ ${t('scan.matched')}${i.year ? ` · ${i.year}` : ''}` : i.quality === 'low' ? `⚠ ${t('scan.lowq')}` : `? ${t('scan.unmatched')}`}</p>
        </form>
      </div>
      ${i.back ? `<a href="${esc(i.back)}" target="_blank" class="big-pic back-pic"><img src="${esc(i.back)}" alt="${t('queue.back_cover')}"></a>` : ''}
      ${i.crop && i.frame ? `<p><a class="small" href="${esc(i.frame)}" target="_blank">${t('queue.whole_photo')}</a></p>` : ''}
      ${i.code && !i.book_id && ['photo', 'video'].includes(i.source) ? `<p class="note small">${t('check.queue_hint')} <a href="/l/${i.code}/check">🔎 ${t('check.title')}</a></p>` : ''}
      <div class="decide">
        <button class="btn primary" data-d="approved">✓ ${t('queue.approve')}</button>
        <button class="btn" data-d="later">⏸ ${t('queue.later')}</button>
        <button class="btn danger" data-d="declined">✕ ${t('queue.decline')}</button>
      </div>
    </section>`;

    const form = root.querySelector('#f');
    root.querySelector('.decide').onclick = async (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      const decision = b.dataset.d;
      const body = { decision };
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
        counts = { ...counts, ...r };
        if (decision === 'later') skipped.add(i.id);
        else items = items.filter((x) => x.id !== i.id);
        if (decision === 'approved' && r.status === 'pending') toast(t('loc.thanks_review'));
        render();
        window.scrollTo(0, 0);
      } catch (err) {
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
  return () => { stopped = true; clearTimeout(timer); };
}
