import { getMe } from './api.js';
import { todoCounts } from './todo.js';
import { esc, avatarHtml, CONTACT_EMAIL } from './ui.js';
import { t } from './i18n.js';

// ☰ in the header: every screen of the app in one list.
export function initMenu() {
  const btn = document.getElementById('menu-btn');
  btn.onclick = open;
  document.addEventListener('seferehov:me', () => getMe(true)); // name or picture changed
}

async function open() {
  const me = await getMe();
  const todo = me ? await todoCounts().catch(() => null) : null;
  const waiting = todo ? ['mine', 'review', 'duplicates', 'texts'].reduce((n, k) => n + (todo[k] ?? 0), 0) : 0;
  // The list opens with the reader: their own picture and screen name, or "sign in".
  const items = [
    me ? [avatarHtml(me, 30), me.screen_name || t('menu.me'), '/me', 'me'] : ['👤', 'menu.signin', '/login'],
    ['🗺️', 'menu.map', '/'],
    ['🔍', 'menu.search', '/search'],
    ['📚', 'menu.mybooks', '/books'],
    ['➕', 'menu.add', '/add'],
    ['🏆', 'menu.top', '/top'],
    ['🌍', 'menu.places', '/places'],
    ...(waiting || me?.trust_level >= 2 ? [['📥', 'todo.title', '/queue', null, waiting]] : []),
    ...(me ? [['🔔', 'menu.watches', '/me#watches']] : []),
    ...(me?.trust_level >= 3 ? [['📊', 'menu.admin', '/admin']] : []),
    ['ℹ️', 'menu.about', '/about'],
    ['✉️', 'menu.feedback', `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(t('contact.subject'))}&body=${encodeURIComponent(`${t('contact.greeting')}\n\n`)}`],
    ['⚙️', 'settings.title', '/settings'],
  ];
  const el = document.createElement('div');
  el.className = 'menu-back';
  el.innerHTML = `<nav class="menu" aria-label="${esc(t('menu.open'))}">
    <button class="x" data-close aria-label="${esc(t('menu.close'))}">✕</button>
    <ul>${items.map(([icon, key, href, cls, n]) => cls === 'me'
      ? `<li><a class="me" href="/me">${icon}${esc(key)}</a></li>`
      : `<li><a href="${esc(href)}"><span>${icon}</span>${esc(t(key))}${n ? ` <b class="count">${n}</b>` : ''}</a></li>`).join('')}</ul>
    <p class="muted small">${esc(__APP_VERSION__)}</p>
  </nav>`;
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a) setTimeout(close); // let the router (or mailto) handle the click first
    else if (e.target === el || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  el.querySelector('a').focus();
}
