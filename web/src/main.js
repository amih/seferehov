import './style.css';
import { initUpdates, maybeApply } from './update.js';
import { startQueue, onQueueChange, flush } from './queue.js';
import { toast } from './ui.js';
import { api, getMe } from './api.js';
import { navigate, mapUnderneath, closeLayer } from './nav.js';
import { trackPageView } from './analytics.js';
import { t, applyLang } from './i18n.js';
import mapView from './views/map.js';
import locationView from './views/location.js';
import addLocationView from './views/add-location.js';
import addBookView from './views/add-book.js';
import loginView from './views/login.js';
import meView from './views/me.js';
import topView from './views/top.js';
import reviewView from './views/review.js';
import aboutView from './views/about.js';
import queueView from './views/queue.js';
import barcodeView from './views/barcode.js';
import bookView, { myBookView } from './views/book.js';
import settingsView from './views/settings.js';
import shelfCheckView from './views/shelf-check.js';
import editLocationView from './views/edit-location.js';
import pageView from './views/page.js';
import { initMenu } from './menu.js';
import './install.js';
import searchView from './views/search.js';
import myBooksView, { addMyBooksView } from './views/my-books.js';
import adminView from './views/admin.js';
import duplicatesView from './views/duplicates.js';
import duplicateLibrariesView from './views/duplicate-libraries.js';
import fixesView from './views/fixes.js';
import traceView from './views/trace.js';
import offersView from './views/offers.js';

const routes = [
  [/^\/$/, mapView],
  [/^\/l\/([A-Za-z0-9]{4,10})\/add$/, addBookView],
  [/^\/l\/([A-Za-z0-9]{4,10})\/barcode$/, barcodeView],
  [/^\/l\/([A-Za-z0-9]{4,10})\/b\/(\d+)$/, bookView],
  [/^\/l\/([A-Za-z0-9]{4,10})\/edit$/, editLocationView],
  [/^\/l\/([A-Za-z0-9]{4,10})\/check$/, shelfCheckView],
  [/^\/l\/([A-Za-z0-9]{4,10})$/, locationView],
  [/^\/(?:queue|scan\/[0-9a-f-]{36})$/, queueView], // /scan/<id>: links in older e-mails
  [/^\/add$/, addLocationView],
  [/^\/search$/, searchView],
  [/^\/books$/, myBooksView],
  [/^\/books\/add$/, addMyBooksView],
  [/^\/books\/(\d+)$/, myBookView],
  [/^\/offers$/, offersView],
  [/^\/duplicates$/, duplicatesView],
  [/^\/duplicate-libraries$/, duplicateLibrariesView],
  [/^\/fixes$/, fixesView],
  [/^\/login$/, loginView],
  [/^\/me$/, meView],
  [/^\/settings$/, settingsView],
  [/^\/top$/, topView],
  [/^\/review$/, reviewView],
  [/^\/admin$/, adminView],
  [/^\/admin\/trace(?:\/([\w-]+))?$/, traceView],
  [/^\/about$/, aboutView],
  [/^\/(places|c\/[a-z]{2}|p\/\d+(-[a-z0-9-]*)?|[br]\/\d+(-[^/]*)?)$/i, pageView],
];

let main = document.getElementById('view');
let cleanup = null;
let renders = 0;

// Screens can take a moment to open (the reader, a screen's own data). A tap on the next
// menu item meanwhile starts another render: the older one then stops, and a screen it
// had already opened is closed at once, so nothing (a map, a camera, timers) is left
// running unseen.
async function render() {
  const n = ++renders;
  const stale = () => n !== renders;
  maybeApply(); // a waiting update is applied between screens
  cleanup?.();
  cleanup = null;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const [, view, params] = routes.map(([re, v]) => [re, v, path.match(re)]).find(([, , m]) => m) ?? [];
  document.body.classList.toggle('full', path === '/');
  const me = await getMe();
  if (stale()) return;
  if (me && !me.screen_name && !['/me', '/about'].includes(path)) {
    sessionStorage.setItem('seferehov:next', location.pathname + location.search);
    history.replaceState(history.state, '', '/me?welcome=1');
    return render();
  }
  // A fresh element per screen: listeners a screen added to it go with it.
  const fresh = main.cloneNode(false);
  main.replaceWith(fresh);
  main = fresh;
  window.scrollTo(0, 0);
  if (!view) {
    main.innerHTML = `<section class="page"><h1>${t('notfound.title')}</h1><p><a href="/">${t('back.map')}</a></p></section>`;
    return;
  }
  trackPageView();
  const done = (await view(main, params.slice(1), new URLSearchParams(location.search))) || null;
  if (stale()) { done?.(); return; }
  cleanup = done;
  showReadyBanner(me, path);
}


document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', () => { if (!closeLayer()) render(); });
window.addEventListener('seferehov:navigate', render);

const badge = document.getElementById('queue-badge');
let queued = 0;
const showBadge = () => { badge.hidden = !queued; badge.textContent = t('queue.waiting', { n: queued }); };
onQueueChange((n) => { queued = n; showBadge(); });

// Static shell text; views re-render themselves on a language change.
// "N books wait for your approval" — reading takes minutes, users wander off.
async function showReadyBanner(me, path) {
  document.getElementById('ready')?.remove();
  if (!me || path === '/' || path === '/queue' || path.startsWith('/scan/') || /\/(add|barcode)$/.test(path)) return;
  let c;
  try { c = await api('/api/queue/count'); } catch { return; }
  if (!c.open || document.getElementById('ready')) return;
  const a = document.createElement('a');
  a.id = 'ready';
  a.className = 'ready-banner';
  a.href = '/queue';
  a.textContent = t('banner.queue', c);
  main.prepend(a);
}

function translateShell() {
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  showBadge();
}
document.addEventListener('seferehov:lang', () => { translateShell(); render(); });
applyLang();
translateShell();

initMenu();

// Errors on the phone go to the server log (a few per page load at most).
let reported = 0;
const report = (message, where, stack) => {
  if (reported++ >= 5) return;
  navigator.sendBeacon?.('/api/client-error', new Blob([JSON.stringify({ message, where, stack, path: location.pathname, version: __APP_VERSION__ })], { type: 'application/json' }));
};
addEventListener('error', (e) => report(e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack));
addEventListener('unhandledrejection', (e) => report(String(e.reason?.message ?? e.reason), 'promise', e.reason?.stack));
initUpdates();
startQueue();
window.addEventListener('online', async () => {
  const sent = await flush();
  if (sent.length) toast(t('queue.uploaded', { n: sent.length }));
});
document.getElementById('app-version').textContent = __APP_VERSION__;
mapUnderneath();
render();
