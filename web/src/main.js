import './style.css';
import { initUpdates, maybeApply } from './update.js';
import { startQueue, onQueueChange, kick, unsentItems, retryNow, discard } from './queue.js';
import { toast, choose, esc } from './ui.js';
import { whyText } from './outbox-ui.js';
import { getMe } from './api.js';
import './net.js';
import { navigate, mapUnderneath, closeLayer } from './nav.js';
import { trackPageView } from './analytics.js';
import { t, lang, applyLang } from './i18n.js';
import mapView from './views/map.js';
import locationView from './views/location.js';
import addLocationView from './views/add-location.js';
import addBookView from './views/add-book.js';
import loginView from './views/login.js';
import meView from './views/me.js';
import topView from './views/top.js';
import reviewView from './views/review.js';
import aboutView from './views/about.js';
import comicView from './views/comic.js';
import queueView from './views/queue.js';
import barcodeView from './views/barcode.js';
import bookView, { myBookView } from './views/book.js';
import settingsView from './views/settings.js';
import shelfCheckView from './views/shelf-check.js';
import editLocationView from './views/edit-location.js';
import pageView from './views/page.js';
import { initMenu } from './menu.js';
import { todoCounts, queueCount, queueCountStale } from './todo.js';
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
  [/^\/comic$/, comicView],
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
  // A screen does not wait long for the reader on a bad connection (getMe answers from the
  // phone's copy after 1.5 s).
  const me = await Promise.race([getMe(), new Promise((r) => setTimeout(() => r(null), 3000))]);
  if (stale()) return;
  if (me && !me.screen_name && !['/me', '/about', '/comic'].includes(path)) {
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
  // Until the screen has drawn itself: "Loading…", never an empty page.
  main.classList.add('loading');
  main.dataset.loading = t('loading');
  const done = (await Promise.resolve(view(main, params.slice(1), new URLSearchParams(location.search))).finally(() => main.classList.remove('loading'))) || null;
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
let queued = { waiting: 0, failed: 0 };
const showBadge = () => {
  badge.hidden = !queued.waiting && !queued.failed;
  badge.textContent = queued.failed ? `⚠️ ${t('out.failed_n', { n: queued.failed })}` : t('queue.waiting', { n: queued.waiting });
};
let wasWaiting = 0;
onQueueChange((c) => {
  if (c.waiting < wasWaiting) queueCountStale(); // a photo reached the server: a scan is being read
  if (wasWaiting && !c.waiting && !c.failed) toast(t('queue.uploaded', { n: wasWaiting }));
  wasWaiting = c.waiting; queued = c; showBadge();
});
// The badge: sends now, and lists what is still on the phone with why: what happened the
// first time and the latest. After "try again" the list comes back with what that try did.
const when = (at) => new Date(at).toLocaleString(lang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function unsentLine(i) {
  const file = Object.values(i.files ?? {}).find(Boolean);
  const pic = file ? `<img class="unsent-pic" src="${esc(URL.createObjectURL(file))}" alt="">` : '';
  // Older items kept only the last refusal, with no time.
  const latest = i.lastProblem ?? (i.error ? { why: i.error, at: i.createdAt } : null);
  const first = i.firstProblem ?? latest;
  const why = !latest ? `<span class="muted small">${t('out.why_waiting')}</span>`
    : `<span class="small">${t('out.first_time', { when: esc(when(first.at)), why: esc(whyText(first)) })}</span>${
      latest.at !== first.at ? `<br><span class="small">${t('out.last_time', { when: esc(when(latest.at)), why: esc(whyText(latest)), n: (i.tries ?? 0) })}</span>` : ''}`;
  return `<li class="unsent">${pic}<span><b>${esc(t(`out.label_${i.label}`) || i.label)}</b> <span class="muted small">${t('out.taken', { when: esc(when(i.createdAt)) })}</span><br>${why}</span></li>`;
}
async function showUnsent(result = null) {
  const items = await unsentItems();
  if (!items.length) { toast(result?.sent ? t('out.all_sent', { n: result.sent }) : t('out.sending_now')); return; }
  const said = result ? `<p class="note">${t('out.tried', { sent: result.sent, left: items.length })}</p>` : '';
  const k = await choose({
    title: t(items.some((i) => i.failed) ? 'out.failed_title' : 'out.unsent_title'),
    html: `${said}<ul class="unsent-list">${items.map(unsentLine).join('')}</ul>`,
    choices: [['retry', `↻ ${t('out.retry')}`, 'primary'], ['drop', `🗑 ${t('out.drop')}`, 'danger'], ['close', t('cancel')]],
  });
  if (k === 'retry') {
    toast(t('out.sending_now'));
    return showUnsent(await retryNow());
  }
  if (k === 'drop') for (const i of items) await discard(i.id);
}
badge.onclick = () => { kick(); showUnsent(); };

// Static shell text; views re-render themselves on a language change.
// "N books wait for your approval" — reading takes minutes, users wander off.
async function showReadyBanner(me, path) {
  document.getElementById('ready')?.remove();
  if (!me || path === '/' || path === '/queue' || path.startsWith('/scan/') || /\/(add|barcode)$/.test(path)) return;
  let c;
  try { c = await queueCount(); } catch { return; }
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

// The menu's to-do count, fetched ahead so the menu shows it at once (todo.js keeps it):
// when the app starts, and when it comes back into view after 10 minutes or more. No timer.
const refreshTodo = (maxAge) => getMe().then((u) => u && todoCounts(u.id, { maxAge })).catch(() => {});
refreshTodo(0);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTodo(600_000); });

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
document.getElementById('app-version').textContent = __APP_VERSION__;
mapUnderneath();
render();
