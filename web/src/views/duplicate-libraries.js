import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, toast, confirmDialog, timeAgo } from '../ui.js';
import { t } from '../i18n.js';
import { todoTabs } from '../todo.js';

// Two libraries at the same spot, at least one added by a reader: keep one (the other's
// reports, photos and alerts move to it, and its old link leads there), or mark them as
// two different libraries.
export default async function duplicateLibrariesView(root) {
  const me = await getMe();
  if (!me) return navigate('/login?next=/duplicate-libraries', { replace: true });
  if (me.trust_level < 2) { root.innerHTML = `<section class="page"><p class="note">${t('dup.not_allowed')}</p></section>`; return; }

  async function load() {
    root.innerHTML = `<section class="page"><h1>${t('duploc.title')}</h1><p class="muted">${t('loading')}</p></section>`;
    let d;
    try { d = await api('/api/duplicate-locations'); } catch (e) { root.querySelector('.muted').textContent = e.message; return; }
    const card = (l, other) => `
      <div class="dup-book">
        ${l.photo ? `<img src="/uploads/${esc(l.photo)}" alt="">` : '<div class="nocover">📚</div>'}
        <strong dir="auto"><a href="/l/${esc(l.code)}" target="_blank">${esc(l.name || t('free_library'))}</a></strong>
        ${l.description ? `<span class="small" dir="auto">${esc(l.description.slice(0, 160))}</span>` : ''}
        <span class="muted small">${l.source === 'osm' ? 'OpenStreetMap' : t('duploc.added_by', { who: esc(l.added_by ?? '—') })} · ${timeAgo(l.created_at)}${l.status === 'pending' ? ` · ${t('duploc.pending')}` : ''}</span>
        <span class="muted small">${t('duploc.uses', { books: l.books, scans: l.scans })}${l.last_report ? ` · ${t('duploc.last', { when: timeAgo(l.last_report) })}` : ''}</span>
        <span class="muted small" dir="ltr">${esc(l.code)}</span>
        <button class="btn primary small" data-keep="${l.id}" data-drop="${other.id}">✓ ${t('duploc.keep')}</button>
      </div>`;
    root.innerHTML = `
    <section class="page">
      ${todoTabs('libraries')}
      <h1>${t('duploc.title')}</h1>
      <p class="muted">${t('duploc.lead')}</p>
      ${d.pairs.length ? d.pairs.map((p) => `
        <div class="dup-pair">
          <p class="small"><b>${t('duploc.apart', { m: p.metres })}</b> ·
            <a href="https://www.openstreetmap.org/?mlat=${p.a.lat}&mlon=${p.a.lon}#map=19/${p.a.lat}/${p.a.lon}" target="_blank" rel="noopener">🗺️ ${t('duploc.map')}</a></p>
          <div class="dup-row">${card(p.a, p.b)}${card(p.b, p.a)}</div>
          <p><button class="btn small" data-a="${p.a.id}" data-b="${p.b.id}">${t('duploc.different')}</button></p>
        </div>`).join('') : `<p class="note">${t('duploc.none')}</p>`}
    </section>`;
  }

  root.addEventListener('click', async (e) => {
    const k = e.target.closest('[data-keep]'), diff = e.target.closest('[data-a]');
    let body;
    if (k) {
      if (!await confirmDialog(t('duploc.confirm_keep'), t('duploc.keep'))) return;
      body = { keep: Number(k.dataset.keep), drop: Number(k.dataset.drop) };
    } else if (diff) body = { a: Number(diff.dataset.a), b: Number(diff.dataset.b), different: true };
    else return;
    try {
      await api('/api/duplicate-locations', { method: 'POST', json: body });
      toast(t(k ? 'duploc.merged' : 'duploc.marked'));
      load();
    } catch (err) { toast(err.message); }
  });
  load();
}
