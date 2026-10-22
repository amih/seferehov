import { t, lang } from './i18n.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(text, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, ms);
}

// Modal with up to two buttons. Resolves true for `ok`, false for `cancel`/dismiss.
// read(el): when given, OK resolves with what it returns (e.g. form values) instead of true.
export function dialog({ title, html, ok, cancel, read }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'dialog-back';
    el.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}<div class="dialog-body">${html}</div>
      <div class="dialog-actions">${ok ? `<button class="btn primary" data-r="1">${esc(ok)}</button>` : ''}${cancel ? `<button class="btn" data-r="0">${esc(cancel)}</button>` : ''}</div></div>`;
    const close = (r) => { const v = r && read ? read(el) : r; el.remove(); resolve(v); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) close(b.dataset.r === '1');
      else if (e.target === el) close(false);
    });
    document.body.append(el);
    el.querySelector('[data-r]')?.focus();
  });
}

// A question with a few answers, each a button: [key, label, class]. Resolves the key of
// the button, or null when closed by a tap outside.
export function choose({ title, html, choices }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'dialog-back';
    el.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}<div class="dialog-body">${html ?? ''}</div>
      <div class="dialog-actions choices">${choices.map(([key, label, cls]) => `<button class="btn ${cls ?? ''}" data-k="${esc(key)}">${esc(label)}</button>`).join('')}</div></div>`;
    const close = (k) => { el.remove(); resolve(k); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) close(b.dataset.k);
      else if (e.target === el) close(null);
    });
    document.body.append(el);
    el.querySelector('[data-k]')?.focus();
  });
}

// "Are you sure?" before an update: resolves true on the OK button.
export function confirmDialog(text, ok) {
  return dialog({ html: `<p>${text}</p>`, ok: ok ?? t('confirm.yes'), cancel: t('cancel') });
}

// Shown when a library name/hint looks like it holds a door code, phone number etc.
// Resolves true when the user insists it is fine (a reviewer will still check).
export function privacyDialog(snippets = []) {
  return dialog({
    title: t('privacy.title'),
    html: `<p>${t('privacy.body')}</p>${snippets.length ? `<ul class="snips">${snippets.map((x) => `<li><mark>${esc(x)}</mark></li>`).join('')}</ul>` : ''}<p class="muted small">${t('privacy.note')}</p>`,
    ok: t('privacy.fix'),
    cancel: t('privacy.send_anyway'),
  }).then((fix) => !fix);
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return t('time.just_now');
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  const units = [[60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s / 60;
  for (const [n, name] of units) {
    if (v < n) return rtf.format(-Math.round(v), name);
    v /= n;
  }
}

export function getPosition({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error(t('geo.none')));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(t(e.code === 1 ? 'geo.denied' : 'geo.fail'))),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}

// Phone photos are 3–12 MB; send at most 2000px JPEG.
export async function shrinkImage(file, maxSide = 2000) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
}

// Round picture, or the first letter of the screen name on a colour picked from it.
const AVATAR_COLORS = ['#3d7cb5', '#3f8f6b', '#c0443a', '#c9962a', '#9a5b2e', '#7b5ea7'];
export function avatarHtml({ avatar, screen_name, name }, size = 32) {
  const label = screen_name ?? name ?? '?';
  if (avatar) return `<img class="avatar" src="${esc(avatar)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`;
  const color = AVATAR_COLORS[[...label].reduce((a, c) => a + c.codePointAt(0), 0) % AVATAR_COLORS.length];
  return `<span class="avatar letter" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${color}">${esc([...label][0]?.toUpperCase() ?? '?')}</span>`;
}

// Opens the reader's own mail app with a ready subject and greeting.
export const CONTACT_EMAIL = 'ami@seferehov.com';
export function contactHtml() {
  const body = `${t('contact.greeting')}\n\n\n\n--\n${t('contact.version')}: ${__APP_VERSION__}`;
  const href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(t('contact.subject'))}&body=${encodeURIComponent(body)}`;
  return `<p>${t('contact.body')}</p>
    <p class="row"><a class="btn" href="${href}">✉️ ${t('contact.button')}</a> <a href="${href}" dir="ltr">${CONTACT_EMAIL}</a></p>`;
}

// "Nothing is required" box; hidden for good once dismissed.
const NOTE_KEY = 'seferehov:nostrings';
export function noStringsNote() {
  try { if (localStorage.getItem(NOTE_KEY)) return ''; } catch { /* show it */ }
  return `<div class="card nostrings"><strong>${t('how.title')}</strong><p>${t('how.body_html')}</p>
    <button class="link" data-dismiss-nostrings>${t('how.dismiss')}</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-dismiss-nostrings]');
  if (!b) return;
  try { localStorage.setItem(NOTE_KEY, '1'); } catch { /* session only */ }
  b.closest('.nostrings')?.remove();
});
