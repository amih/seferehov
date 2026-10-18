import { api } from '../api.js';
import { esc, avatarHtml } from '../ui.js';
import { t } from '../i18n.js';
import { levelOf } from '../levels.js';

export default async function topView(root) {
  root.innerHTML = `<section class="page"><h1>${t('top.title')}</h1>
    <div class="seg"><button data-d="7">${t('top.week')}</button><button data-d="30" class="on">${t('top.month')}</button><button data-d="3650">${t('top.all')}</button></div>
    <div id="stats" class="stats"></div><ol class="leaders" id="list"></ol>
    <p class="muted small">${t('top.legend')}</p></section>`;
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
  api('/api/stats').then((s) => {
    root.querySelector('#stats').innerHTML = `<div><strong>${s.locations}</strong><span>${t('stat.libraries')}</span></div><div><strong>${s.books}</strong><span>${t('stat.books')}</span></div><div><strong>${s.sightings}</strong><span>${t('stat.all_reports')}</span></div>`;
  }).catch(() => {});
}
