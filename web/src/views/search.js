import { api } from '../api.js';
import { esc, getPosition, timeAgo, toast } from '../ui.js';
import { t, lang } from '../i18n.js';
import { navigate } from '../nav.js';
import { watchDialog } from '../watch.js';

const KMS = [1, 5, 20, 50];

// /search?q=&km=&at=lat,lon&from=<town name>. Everything is in the URL, so Back and
// shared links show the same results. km without a point = search anywhere.
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
    <p class="muted small">${t('find.hint')}</p>
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
  let books;
  try { ({ books } = await api(`/api/books/search?${p}`)); } catch (e) { out.innerHTML = `<p class="note">${esc(e.message)}</p>`; return; }
  // Not there yet (or not near): be told when a book with these words is reported.
  const watchWords = text ? `<p class="row"><button class="btn" id="watch-words">${t('watch.words_button')}</button></p>` : '';
  const wireWords = () => { const w = out.querySelector('#watch-words'); if (w) w.onclick = () => watchDialog({ kind: 'words', query: text, pos, km: km ?? 5 }); };
  if (!books.length) { out.innerHTML = `<p>${t('find.none')}</p>${watchWords}`; wireWords(); return; }
  out.innerHTML = `<ul class="books found">${books.map((b, i) => `
    <li>
      ${b.cover_url ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>'}
      <div class="meta">
        <strong>${esc(b.title)}</strong>
        <span>${esc((b.authors ?? []).join(', '))}${b.year ? ` · ${b.year}` : ''}</span>
        <ul class="where">${b.places.map((w) => `<li class="${w.present ? 'here' : 'gone'}">
          <a href="/l/${w.code}">${esc(w.name || t('free_library'))}</a>${w.place ? ` · ${esc(w.place)}` : ''}${
            w.distance_m != null ? ` · ${t('find.away', { km: (w.distance_m / 1000).toFixed(w.distance_m < 10000 ? 1 : 0) })}` : ''}
          — ${w.present ? `<b>${t('find.present')}</b>` : t('find.taken', { when: timeAgo(w.at) })}</li>`).join('')}</ul>
        ${b.waiting?.others ? `<span class="waiting">👥 ${t('watch.waiting', { n: b.waiting.others, mine: b.waiting.mine })}</span>` : ''}
        <button class="link" data-watch="${i}">${t(b.waiting?.mine ? 'watch.on' : 'watch.button')}</button>
      </div>
    </li>`).join('')}</ul>${watchWords}`;
  wireWords();
  out.onclick = (e) => {
    const b = e.target.closest('[data-watch]');
    if (b) watchDialog({ book: books[Number(b.dataset.watch)], pos, km: km ?? 5 });
  };
}

const label = (p) => `${(lang() === 'he' && p.name_he) || p.name}, ${new Intl.DisplayNames([lang()], { type: 'region' }).of(p.country)}`;
