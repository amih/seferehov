import { api, getMe } from '../api.js';
import { navigate } from '../nav.js';
import { esc, timeAgo, toast } from '../ui.js';
import { t } from '../i18n.js';
import { todoTabs } from '../todo.js';

const flag = (f) => (f ? `<p class="note">⚠️ ${t('review.private')}: ${(f.snippets ?? []).map((x) => `<mark>${esc(x)}</mark>`).join(' ')} <span class="muted small">${esc(f.reason ?? '')}</span></p>` : '');
const yesNo = (v) => t(v ? 'review.yes' : 'review.no');

// Old → new for each changed field.
function editLines(e) {
  const c = e.changes;
  const row = (label, from, to) => `<span>${label}: <s class="muted">${esc(from || '—')}</s> → <b>${esc(to || '—')}</b></span><br>`;
  let out = '';
  if ('name' in c) out += row(t('review.f.name'), e.name, c.name);
  if ('description' in c) out += row(t('review.f.description'), e.description, c.description);
  if ('restricted' in c) out += row(t('review.f.restricted'), yesNo(e.restricted), yesNo(c.restricted));
  if (c.photo_id) out += `<span>${t('review.f.photo')} ✓${e.old_thumb ? ` <a href="${e.old_thumb}" target="_blank">⟲</a>` : ''}</span><br>`;
  if (c.lat != null) out += `<span>📍 ${t('review.f.moved', { m: c.moved_m })} · <a href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=19/${c.lat}/${c.lon}" target="_blank" rel="noopener">${t('review.map')}</a></span><br>`;
  if (c.removed) out += `<span>🗑️ <b>${t('review.f.removed')}</b></span><br>`;
  return out;
}

export default async function reviewView(root) {
  const me = await getMe();
  if (!me || me.trust_level < 2) return navigate('/me', { replace: true });
  const { locations, edits = [], sightings } = await api('/api/review');
  const who = (r) => esc(r.by_name);
  root.innerHTML = `
  <section class="page">
    ${todoTabs('review')}
    <h1>${t('review.title')}</h1>
    <h2>${t('review.libs')} <span class="count">${locations.length}</span></h2>
    <ul class="review">${locations.map((l) => `
      <li data-type="location" data-id="${l.id}">
        ${l.thumb ? `<img src="${l.thumb}" alt="">` : '<span class="noimg"></span>'}
        <div>${flag(l.privacy_flag)}<strong>${esc(l.name || t('review.noname'))}</strong> ${l.restricted ? '🔒' : ''}<br>
          <span>${esc(l.description || '')}</span><br>
          <span class="muted">${who(l)} · ${timeAgo(l.created_at)} ·
          <a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lon}#map=19/${l.lat}/${l.lon}" target="_blank" rel="noopener">${t('review.map')}</a></span></div>
        <div class="col"><button class="btn primary" data-d="approved">${t('review.approve')}</button><button class="btn" data-d="rejected">${t('review.reject')}</button></div>
      </li>`).join('') || `<p class="muted">${t('review.nothing')}</p>`}</ul>
    <h2>${t('review.edits')} <span class="count">${edits.length}</span></h2>
    <ul class="review">${edits.map((e) => `
      <li data-type="edit" data-id="${e.id}">
        ${e.new_thumb ? `<img src="${e.new_thumb}" alt="">` : e.old_thumb ? `<img src="${e.old_thumb}" alt="">` : '<span class="noimg"></span>'}
        <div>${flag(e.privacy_flag)}<strong><a href="/l/${e.code}">${esc(e.name || e.code)}</a></strong><br>
          ${editLines(e)}
          ${e.note ? `<span>💬 ${esc(e.note)}</span><br>` : ''}
          <span class="muted">${who(e)} · ${timeAgo(e.created_at)}</span></div>
        <div class="col"><button class="btn primary" data-d="approved">${t('review.approve')}</button><button class="btn" data-d="rejected">${t('review.reject')}</button></div>
      </li>`).join('') || `<p class="muted">${t('review.nothing')}</p>`}</ul>
    <h2>${t('review.reports')} <span class="count">${sightings.length}</span></h2>
    <ul class="review">${sightings.map((s) => `
      <li data-type="sighting" data-id="${s.id}">
        ${s.thumb || s.cover_url ? `<img src="${esc(s.thumb || s.cover_url)}" alt="">` : '<span class="noimg"></span>'}
        <div><strong>${esc(s.title)}</strong> — ${t(`review.kind.${s.kind}`)}<br>
          <span class="muted">${t('review.at')} <a href="/l/${s.code}">${esc(s.location_name || s.code)}</a> · ${who(s)} · ${timeAgo(s.created_at)}
          ${s.distance_m == null ? ` · ${t('review.no_gps')}` : ` · ${t('review.away', { m: s.distance_m })}`}</span></div>
        <div class="col"><button class="btn primary" data-d="approved">${t('review.approve')}</button><button class="btn" data-d="rejected">${t('review.reject')}</button></div>
      </li>`).join('') || `<p class="muted">${t('review.nothing')}</p>`}</ul>
  </section>`;
  root.onclick = async (e) => {
    const b = e.target.closest('button[data-d]');
    if (!b) return;
    const li = b.closest('li');
    try {
      await api(`/api/review/${li.dataset.type}/${li.dataset.id}`, { method: 'POST', json: { decision: b.dataset.d } });
      li.remove();
    } catch (err) { toast(err.message); }
  };
  return () => { root.onclick = null; };
}
