import { toast } from './ui.js';
import { pendingCount } from './queue.js';
import { t } from './i18n.js';

// How the app stays current without anyone ever needing a "hard refresh":
//  1. The worker is checked for updates on load, whenever the app comes back to
//     the foreground, every hour, and whenever the API reports a different version.
//  2. A new worker installs in the background and waits.
//  3. We switch to it only at a safe moment: right away if the app is hidden,
//     otherwise on the next screen change — never while uploads are queued. On screens
//     where the reader taps through one item after another (approving, the camera), not
//     even when hidden: a reload under a finger turns the next tap into a wrong decision.
//  4. After the reload, a toast says what version is now running.

let reg = null;
let waiting = false;

export function initUpdates() {
  const prev = sessionStorage.getItem('seferehov:updatedFrom');
  if (prev) {
    sessionStorage.removeItem('seferehov:updatedFrom');
    if (prev !== __APP_VERSION__) toast(t('updated', { v: __APP_VERSION__ }));
  }
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;

  const sw = navigator.serviceWorker;
  // First install takes control without a reload; later switches always reload,
  // even when another tab triggered them, so the page matches its cached files.
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    sessionStorage.setItem('seferehov:updatedFrom', __APP_VERSION__);
    location.reload();
  });

  sw.register('/sw.js', { updateViaCache: 'none' }).then((r) => {
    reg = r;
    if (r.waiting && sw.controller) onWaiting();
    r.addEventListener('updatefound', () => {
      const w = r.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && sw.controller) onWaiting();
      });
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
    else maybeApply({ hidden: true });
  });
  setInterval(checkForUpdate, 60 * 60 * 1000);
}

const BUSY_SCREENS = /^\/(queue|review|fixes|duplicates|books\/add|l\/[^/]+\/(add|barcode|check))\/?$/;

function onWaiting() {
  waiting = true;
  if (document.visibilityState === 'hidden') maybeApply({ hidden: true });
}

export function checkForUpdate() {
  reg?.update().catch(() => {});
}

// Called by the router on every screen change and when the app goes to the
// background. Never switches while uploads are waiting in the offline queue.
export async function maybeApply({ hidden = false } = {}) {
  if (!waiting || !reg?.waiting) return;
  if (hidden && BUSY_SCREENS.test(location.pathname)) return;
  if (await pendingCount()) return;
  waiting = false;
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export const isUpdateWaiting = () => waiting;

// Last resort for a broken install: drop every cache and worker, reload.
export async function hardReset() {
  for (const r of await navigator.serviceWorker?.getRegistrations() ?? []) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  sessionStorage.setItem('seferehov:updatedFrom', 'reset');
  location.reload();
}
