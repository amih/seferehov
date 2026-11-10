import { api } from '../api.js';
import { esc, avatarHtml, getPosition } from '../ui.js';
import { t } from '../i18n.js';
import { levelOf } from '../levels.js';

export default async function topView(root) {
  root.innerHTML = `<section class="page"><h1>${t('top.title')}</h1>
    <div class="seg"><button data-d="7">${t('top.week')}</button><button data-d="30" class="on">${t('top.month')}</button><button data-d="3650">${t('top.all')}</button></div>
    <div id="stats" class="stats"></div><ol class="leaders" id="list"></ol>
    <p class="muted small">${t('top.legend')}</p>
    <div id="help"></div></section>`;
  const list = root.querySelector('#list');
  async function load(days) {
    try {
      const { leaders } = await api(`/api/leaderboard?days=${days}`);
      list.innerHTML = leaders.length ? leaders.map((l) => {
        const { level } = levelOf(l.karma);
        const who = `${avatarHtml(l, 28)}${esc(l.name)} <span title="${esc(t(`level.${level.key}`))}">${level.badge}</span>`;
        return `<li><span class="who">${l.public ? `<a href="/r/${l.id}">${who}</a>` : who}</span><strong>${l.points}</strong></li>`;
      }).join('') : `<p class="muted">${t('top.none')}</p>`;
    } catch { list.innerHTML = `<p class="muted">${t('offline.short')}</p>`; }
  }
  root.querySelector('.seg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    root.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    load(b.dataset.d);
  };
  load(30);
  helpWanted(root.querySelector('#help'));
  api('/api/stats').then((s) => {
    root.querySelector('#stats').innerHTML = `<div><strong>${s.locations}</strong><span>${t('stat.libraries')}</span></div><div><strong>${s.books}</strong><span>${t('stat.books')}</span></div><div><strong>${s.sightings}</strong><span>${t('stat.all_reports')}</span></div>`;
  }).catch(() => {});
}

// Libraries with books that have no cover photos, nearest first when the phone may already
// tell where it is (never asks for permission here).
async function helpWanted(box) {
  const granted = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state === 'granted').catch(() => false);
  const pos = granted ? await getPosition({ timeout: 5000 }).catch(() => null) : null;
  const q = pos ? `?lat=${pos.lat.toFixed(3)}&lon=${pos.lon.toFixed(3)}` : '';
  const r = await api(`/api/libraries/need-help${q}`).catch(() => null);
  if (!r?.libraries?.length) return;
  box.innerHTML = `<h2>📷 ${t('help.title')}</h2><p>${t('help.lead', r.points)}</p>
    <ul class="help-list">${r.libraries.map((l) => `<li><a href="/l/${esc(l.code)}"><b>${esc(l.name || t('free_library'))}</b></a>
      <span class="muted small">${t('help.row', { covers: l.need_covers, spines: l.open_spines })}${l.metres != null ? ` · ${t('help.km', { km: (l.metres / 1000).toFixed(1) })}` : ''}</span></li>`).join('')}</ul>`;
}
