import { api } from '../api.js';
import { esc } from '../ui.js';
import { t, lang } from '../i18n.js';
import { contactOffer } from '../offers.js';

// Books readers offer from home, for sale or to give away: the latest, anywhere or in one
// town. Each links to its book page; "write to the owner" goes by e-mail through the app.
export default async function offersView(root, _params, query) {
  const kind = ['sale', 'give'].includes(query?.get('kind')) ? query.get('kind') : '';
  const place = Number(query?.get('place')) || '';
  root.innerHTML = `
  <section class="page">
    <h1>${t('offer.list_title')}</h1>
    <p class="muted">${t('offer.list_lead')}</p>
    <div class="seg" id="kind">${[['', 'offer.all'], ['give', 'offer.give'], ['sale', 'offer.sale']].map(([k, l]) =>
      `<a class="${k === kind ? 'on' : ''}" href="/offers?${new URLSearchParams({ ...(k ? { kind: k } : {}), ...(place ? { place } : {}) })}">${t(l)}</a>`).join('')}</div>
    <div id="list"><p class="muted">${t('loading')}</p></div>
    <p class="muted small">${t('offer.how_to')} <a href="/books">${t('mybooks.title')}</a></p>
  </section>`;
  let offers;
  try { ({ offers } = await api(`/api/offers?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(place ? { place } : {}) })}`)); }
  catch { root.querySelector('#list').innerHTML = `<p class="note">${t('offline')}</p>`; return; }
  const where = (o) => (o.place ? esc((lang() === 'he' && o.place_he) || o.place) : '');
  root.querySelector('#list').innerHTML = offers.length ? `<ul class="books">${offers.map((o) => `
    <li><a href="${esc(o.path)}">${o.photo || o.cover_url ? `<img src="${esc(o.photo || o.cover_url)}" alt="" loading="lazy">` : '<div class="nocover">📖</div>'}</a><div class="meta">
      <a class="title-link" href="${esc(o.path)}"><strong dir="auto">${esc(o.title)}</strong></a><span class="muted" dir="auto">${esc((o.authors ?? []).join(', '))}</span>
      <span class="small"><b>${o.offer === 'give' ? `🎁 ${t('offer.give')}` : `🏷️ ₪${o.price}`}</b>${o.condition ? ` · ${t(`offer.cond_${o.condition}`)}` : ''}${
        o.place ? ` · <a href="/offers?place=${o.offer_place_id ?? ''}">${where(o)}</a>` : ''} · ${esc(o.screen_name)}</span>
      ${o.offer_note ? `<span class="small" dir="auto">${esc(o.offer_note)}</span>` : ''}
      ${o.mine ? `<span class="small muted">${t('offer.yours')}</span>` : `<span class="row"><button class="btn small" data-contact="${o.id}" data-give="${o.offer === 'give' ? 1 : 0}">✉️ ${t(o.offer === 'give' ? 'offer.contact_give' : 'offer.contact_sale')}</button></span>`}
    </div></li>`).join('')}</ul>` : `<p class="muted">${t('offer.none')}</p>`;
  root.querySelector('#list').onclick = (e) => {
    const b = e.target.closest('[data-contact]');
    if (b) contactOffer(Number(b.dataset.contact), b.dataset.give === '1');
  };
}
