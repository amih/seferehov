import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';
import { todoTabs } from '../todo.js';

// Books that look like the same book entered twice: keep the better record (the
// other's sightings, pictures and codes move to it), fix title and author entered
// in each other's fields, or mark the two as different books.
export default async function duplicatesView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/duplicates', { replace: true });
  if (me.trust_level < 2) { root.innerHTML = `<section class="page"><p class="note">${t('dup.not_allowed')}</p></section>`; return; }

  async function load() {
    root.innerHTML = `<section class="page"><h1>${t('dup.title')}</h1><p class="muted">${t('loading')}</p></section>`;
    let d;
    try { d = await api('/api/duplicates'); } catch (e) { root.querySelector('.muted').textContent = e.message; return; }
    const card = (b, other) => `
      <div class="dup-book">
        ${b.cover_url ? `<img src="${esc(b.cover_url)}" alt="">` : '<div class="nocover">📖</div>'}
        <strong dir="auto">${esc(b.title)}</strong>
        <span dir="auto">${esc((b.authors ?? []).join(', '))}</span>
        <span class="muted small" dir="ltr">${[b.isbn13 && `ISBN ${b.isbn13}`, b.danacode && `Danacode ${b.danacode}`, b.year].filter(Boolean).map(esc).join(' · ')}</span>
        <span class="muted small">${t('dup.uses', { s: b.sightings, m: b.mine })}${b.has_blurb ? ` · ${t('dup.blurb')}` : ''} · ${esc(b.source)}</span>
        <button class="btn primary small" data-keep="${b.id}" data-drop="${other.id}">✓ ${t('dup.keep')}</button>
        ${b.authors?.length ? `<button class="link small" data-swap="${b.id}">⇄ ${t('dup.swap')}</button>` : ''}
      </div>`;
    root.innerHTML = `
    <section class="page">
      ${todoTabs('duplicates')}
      <h1>${t('dup.title')}</h1>
      <p class="muted">${t('dup.lead')}</p>
      ${d.pairs.length ? d.pairs.map((p) => `
        <div class="dup-pair">
          <p class="small"><b>${t(`dup.why_${p.why}`)}</b></p>
          <div class="dup-row">${card(p.a, p.b)}${card(p.b, p.a)}</div>
          <p><button class="btn small" data-a="${p.a.id}" data-b="${p.b.id}">${t('dup.different')}</button></p>
        </div>`).join('') : `<p class="note">${t('dup.none')}</p>`}
    </section>`;
  }

  root.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-keep]'), sw = e.target.closest('[data-swap]'), diff = e.target.closest('[data-a]');
    let body, url = '/api/duplicates';
    if (k) {
      if (!await confirmDialog(t('dup.confirm_keep'), t('dup.keep'))) return;
      body = { keep: Number(k.dataset.keep), drop: Number(k.dataset.drop) };
    }
    else if (diff) body = { a: Number(diff.dataset.a), b: Number(diff.dataset.b), different: true };
    else if (sw) { url = `/api/books/${sw.dataset.swap}/swap`; body = {}; } else return;
    try {
      await api(url, { method: 'POST', json: body });
      toast(t(k ? 'dup.merged' : sw ? 'dup.swapped' : 'dup.marked'));
      load();
    } catch (err) { toast(err.message); }
  });
  load();
}
