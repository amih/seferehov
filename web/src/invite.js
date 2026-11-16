import { api } from './api.js';
import { dialog, esc, toast } from './ui.js';
import { t, lang } from './i18n.js';

// Sharing a link: the phone's own share sheet (WhatsApp, SMS, e-mail…) where there is one;
// else a small window with the link to copy and WhatsApp / SMS / e-mail links.
export async function shareLink({ url, text, title }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  const body = `${text}\n${url}`;
  const shown = dialog({
    title: title || t('invite.share'),
    html: `<p><input class="share-url" readonly value="${esc(url)}" dir="ltr"></p>
      <p class="row share-links">
        <button type="button" class="btn small" data-copy>${t('invite.copy')}</button>
        <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(body)}">WhatsApp</a>
        <a class="btn small" href="sms:?&body=${encodeURIComponent(body)}">SMS</a>
        <a class="btn small" href="mailto:?subject=${encodeURIComponent(title || t('app.name'))}&body=${encodeURIComponent(body)}">E-mail</a>
      </p>`,
    ok: t('menu.close'),
  });
  const el = document.querySelector('.dialog-back:last-of-type');
  el?.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast(t('invite.copied')); } catch { el.querySelector('.share-url').select(); }
  });
  await shown;
}

// The invite code from a link (/?i=<code>) is kept until the reader is signed in.
const KEY = 'seferehov:invite';
export const validCode = (c) => /^[A-Za-z0-9_-]{8,32}$/.test(String(c ?? ''));
export function rememberInvite(code) { if (validCode(code)) localStorage.setItem(KEY, code); }
// Once signed in: tell the server who invited this reader (it counts new accounts only).
export async function joinInvite() {
  const code = localStorage.getItem(KEY);
  if (!validCode(code)) return;
  try { await api(`/api/invites/${code}/join`, { method: 'POST' }); localStorage.removeItem(KEY); } catch (e) {
    if (e.status === 404) localStorage.removeItem(KEY);
  }
}

const placeName = (p) => (lang() === 'he' && p.name_he) || p.name;
// The reader's town, asked once before something of theirs is made public.
export async function askTown() {
  let towns = [];
  const shown = dialog({
    title: t('public.town_title'),
    html: `<form><p class="muted small">${t('public.town_why')}</p>
      <label>${t('offer.town')} <input name="town" list="public-towns" autocomplete="off" placeholder="${esc(t('offer.town_ph'))}"></label>
      <datalist id="public-towns"></datalist></form>`,
    ok: t('offer.save'),
    cancel: t('cancel'),
    read: (el) => el.querySelector('[name=town]').value.trim(),
  });
  const el = document.querySelector('.dialog-back:last-of-type');
  const input = el.querySelector('[name=town]');
  input.oninput = async () => {
    const v = input.value.trim();
    if (v.length < 2 || towns.some((p) => placeName(p) === v)) return;
    try { ({ places: towns } = await api(`/api/places/search?any=1&q=${encodeURIComponent(v)}`)); } catch { return; }
    el.querySelector('#public-towns').innerHTML = towns.map((p) => `<option value="${esc(placeName(p))}">`).join('');
  };
  const v = await shown;
  if (!v) return false;
  const town = towns.find((p) => placeName(p) === v);
  if (!town) { toast(t('offer.need_town')); return askTown(); }
  await api('/api/me/home-place', { method: 'PUT', json: { place_id: town.id } });
  return true;
}

// PUT a public switch; asks for the town first when the server says it is missing.
export async function setPublic(path, on) {
  try {
    return await api(path, { method: 'PUT', json: { public: on } });
  } catch (e) {
    if (e.body?.error === 'town_required' && await askTown()) {
      return api(path, { method: 'PUT', json: { public: on } }).catch((err) => { toast(err.message); return null; });
    }
    if (e.body?.error !== 'town_required') toast(e.message);
    return null;
  }
}
