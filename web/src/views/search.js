import { api } from '../api.js';
import { esc, getPosition, timeAgo, toast } from '../ui.js';
import { t, lang } from '../i18n.js';
import { navigate } from '../nav.js';
import { watchDialog } from '../watch.js';
import { bookFacts, GENRES, LANGUAGES, PERIODS } from '../genres.js';

const KMS = [1, 5, 20, 50];

// /search?q=&km=&at=lat,lon&from=<town name>. Everything is in the URL, so Back and
// shared links show the same results. km without a point = search anywhere. The results
// can be narrowed by genre, language, period and when last scanned, and sorted (also in
// the URL); each choice shows how many of the books found it would leave.
const FILTERS = { genre: GENRES, language: LANGUAGES, period: PERIODS, days: ['7', '30', '365'] };
const SORTS = ['match', 'recent', 'near', 'copies', 'year_new', 'year_old', 'title'];
export default async function searchView(root, _, query) {
  const text = query.get('q') ?? '';
  const km = KMS.includes(Number(query.get('km'))) ? Number(query.get('km')) : null;
  const at = (query.get('at') ?? '').split(',').map(Number);
  let pos = at.length === 2 && at.every(Number.isFinite) ? { lat: at[0], lon: at[1] } : null;
  let from = query.get('from') ?? (pos ? t('find.my_location') : '');
  let towns = [];

  root.innerHTML = `
  <section class="page">
    <h1>${t('find.title')}</h1>
    <form class="form" id="f">
      <input type="search" name="q" value="${esc(text)}" placeholder="${t('find.ph')}" enterkeyhint="search" autocomplete="off">
      <p class="label">${t('find.distance')}</p>
      <div class="seg" id="km">${KMS.map((n) => `<button type="button" data-km="${n}">${t('find.km', { n })}</button>`).join('')}<button type="button" data-km="">${t('find.anywhere')}</button></div>
      <div class="row from" ${km ? '' : 'hidden'}>
        <span>${t('find.from')}</span>
        <button type="button" class="btn" id="me">${t('find.my_location')}</button>
        <input name="town" list="towns" placeholder="${t('find.town_ph')}" value="${esc(from === t('find.my_location') ? '' : from)}" autocomplete="off">
        <datalist id="towns"></datalist>
      </div>
      <p class="muted small" id="where">${pos && km ? esc(from) : ''}</p>
      <button class="btn primary big">${t('find.go')}</button>
    </form>
    <p class="muted small">${t('find.hint')} <a href="/search?all=1">${t('browse.all')}</a></p>
    <div id="results"></div>
  </section>`;

  const form = root.querySelector('#f');
  let chosenKm = km;
  const showKm = () => {
    root.querySelectorAll('#km button').forEach((b) => b.classList.toggle('on', String(chosenKm ?? '') === b.dataset.km));
    root.querySelector('.from').hidden = !chosenKm;
  };
  showKm();
  const useMyLocation = async () => {
    try { pos = await getPosition(); from = t('find.my_location'); form.town.value = ''; root.querySelector('#where').textContent = from; }
    catch (e) { toast(e.message); }
  };
  root.querySelector('#km').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    chosenKm = b.dataset.km ? Number(b.dataset.km) : null;
    showKm();
    if (chosenKm && !pos) await useMyLocation();
  };
  root.querySelector('#me').onclick = useMyLocation;
  form.town.oninput = async () => {
    const v = form.town.value.trim();
    const hit = towns.find((p) => label(p) === v);
    if (hit) { pos = { lat: hit.lat, lon: hit.lon }; from = v; root.querySelector('#where').textContent = v; return; }
    if (v.length < 2) return;
    try { ({ places: towns } = await api(`/api/places/search?q=${encodeURIComponent(v)}`)); } catch { return; }
    root.querySelector('#towns').innerHTML = towns.map((p) => `<option value="${esc(label(p))}">`).join('');
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (chosenKm && !pos) { toast(t('find.need_place')); return; }
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (chosenKm) { p.set('km', chosenKm); p.set('at', `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`); p.set('from', from); }
    if (![...p.keys()].length) p.set('all', '1'); // no words, anywhere: the latest books
    navigate(`/search?${p}`);
  };

  if (!text && !(pos && km) && !query.has('all')) return;
  const out = root.querySelector('#results');
  out.innerHTML = `<p class="muted">${t('loading')}</p>`;
  const p = new URLSearchParams({ lang: lang() });
  if (text) p.set('q', text);
  if (pos) { p.set('lat', pos.lat); p.set('lon', pos.lon); }
  if (km) p.set('km', km);
  const chosen = {};
  for (const k of [...Object.keys(FILTERS), 'sort']) { const v = query.get(k); if (v) { chosen[k] = v; p.set(k, v); } }
  let books, facets, total;
  try { ({ books, facets, total } = await api(`/api/books/search?${p}`)); } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; return; }
  // Not there yet (or not near): be told when a book with these words is reported.
  const watchWords = text ? `<p class="row"><button class="btn" id="watch-words">${t('watch.words_button')}</button></p>` : '';
  const wireWords = () => { const w = out.querySelector('#watch-words'); if (w) w.onclick = () => watchDialog({ kind: 'words', query: text, pos, km: km ?? 5 }); };
  // A select per filter (only values some book found has, with counts), and the order.
  const sel = (k, values, label, count = null) => `<label class="small">${t(label)} <select data-filter="${k}">
      <option value="">${t(k === 'sort' ? 'sort.match' : 'browse.any')}</option>
      ${values.filter((v) => k === 'sort' ? v !== 'match' && (v !== 'near' || pos) : count?.[v] || chosen[k] === v).map((v) =>
        `<option value="${v}"${chosen[k] === v ? ' selected' : ''}>${esc(t(k === 'sort' ? `sort.${v}` : `${k === 'days' ? 'days' : k}.${v}`))}${count ? ` (${count[v] ?? 0})` : ''}</option>`).join('')}</select></label>`;
  const bar = `<div class="filters">
      ${sel('genre', GENRES, 'browse.genre', facets?.genre)}${sel('language', LANGUAGES, 'browse.language', facets?.language)}
      ${sel('period', PERIODS, 'browse.period', facets?.period)}${sel('days', FILTERS.days, 'browse.days')}
      ${sel('sort', SORTS, 'browse.sort')}</div>
    <p class="muted small">${t('browse.total', { n: total ?? books.length })}</p>`;
  const wireBar = () => out.querySelectorAll('[data-filter]').forEach((el) => {
    el.onchange = () => {
      const u = new URLSearchParams(location.search);
      if (el.value) u.set(el.dataset.filter, el.value); else u.delete(el.dataset.filter);
      navigate(`/search?${u}`, { replace: true });
    };
  });
  if (!books.length) { out.innerHTML = `${Object.keys(chosen).length ? bar : ''}<p>${t('find.none')}</p>${watchWords}`; wireWords(); wireBar(); return; }
  out.innerHTML = `${bar}<ul class="books found">${books.map((b, i) => `
    <li>
      ${b.cover_url ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>'}
      <div class="meta">
        <strong>${esc(b.title)}</strong>
        <span>${esc((b.authors ?? []).join(', '))}</span>
        ${bookFacts(b) ? `<span class="small muted">${esc(bookFacts(b))}</span>` : ''}
        <span class="small muted">${b.copies ? `${t('browse.copies', b)} · ` : ''}${t('browse.last_seen', { when: timeAgo(b.last_seen) })}</span>
        <ul class="where">${b.places.map((w) => `<li class="${w.present ? 'here' : 'gone'}">
          <a href="/l/${w.code}">${esc(w.name || t('free_library'))}</a>${w.place ? ` · ${esc(w.place)}` : ''}${
            w.distance_m != null ? ` · ${t('find.away', { km: (w.distance_m / 1000).toFixed(w.distance_m < 10000 ? 1 : 0) })}` : ''}
          — ${w.present ? `<b>${t('find.present')}</b>` : t('find.taken', { when: timeAgo(w.at) })}</li>`).join('')}</ul>
        ${b.waiting?.others ? `<span class="waiting">👥 ${t('watch.waiting', { n: b.waiting.others, mine: b.waiting.mine })}</span>` : ''}
        <button class="link" data-watch="${i}">${t(b.waiting?.mine ? 'watch.on' : 'watch.button')}</button>
      </div>
    </li>`).join('')}</ul>${watchWords}`;
  wireWords();
  wireBar();
  out.onclick = (e) => {
    const b = e.target.closest('[data-watch]');
    if (b) watchDialog({ book: books[Number(b.dataset.watch)], pos, km: km ?? 5 });
  };
}

const label = (p) => `${(lang() === 'he' && p.name_he) || p.name}, ${new Intl.DisplayNames([lang()], { type: 'region' }).of(p.country)}`;
