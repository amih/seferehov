import { api, getMe } from './api.js';
import { navigate } from './nav.js';
import { dialog, esc, toast } from './ui.js';
import { t, lang } from './i18n.js';

// Offering one of my books for sale or to give away (only offered books are public, with
// the town, never an address), and writing to the owner of an offered book.
const CONDITIONS = ['new', 'like_new', 'good', 'fair'];
const placeName = (p) => (lang() === 'he' && p.name_he) || p.name;

// The short line under a book in My books.
export function offerLine(r) {
  if (!r.offer) return '';
  const where = r.offer_place ? ` · ${esc((lang() === 'he' && r.offer_place_he) || r.offer_place)}` : '';
  return `<span class="small offer-tag">${r.offer === 'give' ? `🎁 ${t('offer.give')}` : `🏷️ ${t('offer.sale')} · ₪${r.price}`}${where}</span>`;
}

// Resolves true when the offer was saved or taken down.
export async function offerDialog(item) {
  let place = item.offer_place_id ? { id: item.offer_place_id, name: item.offer_place, name_he: item.offer_place_he } : null;
  if (!place) place = (await api('/api/me/home-place').catch(() => ({}))).place ?? null;
  let towns = place ? [place] : [];
  const kind = item.offer ?? 'give';
  const shown = dialog({
    title: t('offer.title', { title: item.title }),
    html: `<form class="offer-form">
      <div class="seg" data-kind><button type="button" data-k="give">🎁 ${t('offer.give')}</button><button type="button" data-k="sale">🏷️ ${t('offer.sale')}</button></div>
      <label class="price-row">${t('offer.price')} <input name="price" type="number" inputmode="numeric" min="1" max="100000" value="${item.price ?? ''}" placeholder="₪"></label>
      <label>${t('offer.condition')} <select name="condition"><option value="">—</option>${CONDITIONS.map((c) =>
        `<option value="${c}"${item.condition === c ? ' selected' : ''}>${t(`offer.cond_${c}`)}</option>`).join('')}</select></label>
      <label>${t('offer.town')} <input name="town" list="offer-towns" autocomplete="off" value="${esc(place ? placeName(place) : '')}" placeholder="${esc(t('offer.town_ph'))}"></label>
      <datalist id="offer-towns"></datalist>
      <label>${t('offer.note')} <input name="note" maxlength="300" value="${esc(item.offer_note ?? '')}" placeholder="${esc(t('offer.note_ph'))}"></label>
      <p class="muted small">${t('offer.privacy')}</p>
      ${item.offer ? `<p><button type="button" class="btn small" data-stop>✕ ${t('offer.stop')}</button></p>` : ''}
    </form>`,
    ok: t('offer.save'),
    cancel: t('cancel'),
    read: (el) => {
      const f = el.querySelector('form');
      return { offer: f.dataset.kind, price: f.price.value, condition: f.condition.value, note: f.note.value.trim(), town: f.town.value.trim() };
    },
  });
  const el = document.querySelector('.dialog-back:last-of-type');
  const f = el.querySelector('form');
  const setKind = (k) => {
    f.dataset.kind = k;
    f.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    f.querySelector('.price-row').hidden = k !== 'sale';
  };
  setKind(kind);
  f.querySelector('[data-kind]').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) setKind(b.dataset.k); };
  f.town.oninput = async () => {
    const v = f.town.value.trim();
    if (v.length < 2 || towns.some((p) => placeName(p) === v)) return;
    try { ({ places: towns } = await api(`/api/places/search?any=1&q=${encodeURIComponent(v)}`)); } catch { return; }
    el.querySelector('#offer-towns').innerHTML = towns.map((p) => `<option value="${esc(placeName(p))}">`).join('');
  };
  let stopped = false;
  el.querySelector('[data-stop]')?.addEventListener('click', async () => {
    await api(`/api/my-books/${item.id}/offer`, { method: 'DELETE' }).catch((err) => toast(err.message));
    stopped = true;
    el.querySelector('[data-r="0"]').click();
  });
  const v = await shown;
  if (stopped) return true;
  if (!v) return false;
  const town = towns.find((p) => placeName(p) === v.town);
  if (!town) { toast(t('offer.need_town')); return offerDialog({ ...item, ...v, offer_place_id: null }); }
  try {
    await api(`/api/my-books/${item.id}/offer`, { method: 'PUT', json: { offer: v.offer, price: v.price, condition: v.condition, note: v.note, place_id: town.id } });
    toast(t('offer.saved'));
    return true;
  } catch (e) {
    const err = e.body?.error;
    toast(err === 'private_info' ? t('offer.no_contact') : err === 'price_required' ? t('offer.need_price') : e.message);
    return offerDialog({ ...item, offer: v.offer, price: v.price, condition: v.condition, offer_note: v.note, offer_place_id: town.id, offer_place: town.name, offer_place_he: town.name_he });
  }
}

// "Write to the owner": the message goes by e-mail, with the buyer's address to reply to.
export async function contactOffer(id, give) {
  if (!await getMe()) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
  const text = await dialog({
    title: t(give ? 'offer.contact_give' : 'offer.contact_sale'),
    html: `<textarea name="text" rows="5" maxlength="1000" placeholder="${esc(t('offer.msg_ph'))}"></textarea><p class="muted small">${t('offer.msg_note')}</p>`,
    ok: t('offer.send'),
    cancel: t('cancel'),
    read: (el) => el.querySelector('textarea').value.trim(),
  });
  if (!text) return;
  try {
    await api(`/api/offers/${id}/contact`, { method: 'POST', json: { text } });
    toast(t('offer.sent'));
  } catch (e) {
    toast(e.body?.error === 'own_offer' ? t('offer.own') : e.body?.error === 'too_many' ? t('offer.too_many') : e.message);
  }
}
