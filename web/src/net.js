import { t } from './i18n.js';

// "The server is not answering" bar. Shown when a request has waited a few seconds, failed
// without an answer (no signal, a stale DNS address, the server down), or was answered from
// what the phone kept (sw.js). It never blocks the screen: what is on it stays usable, and
// photos keep going to the outbox. While it shows, the server is asked every few seconds,
// and the bar goes away by itself on the first real answer.

const SLOW_MS = 4000;
let bar = null;
let state = 'ok'; // ok | slow | down | stale | offline
let pending = 0;
let probe = null;
let probeEvery = 5000;

function show(next) {
  if (!navigator.onLine) next = 'offline';
  if (state === next) return;
  state = next;
  if (next === 'ok') {
    bar?.remove();
    bar = null;
    clearTimeout(probe);
    probe = null;
    probeEvery = 5000;
    document.dispatchEvent(new Event('seferehov:online'));
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'net-bar';
    bar.setAttribute('role', 'status');
    bar.addEventListener('click', (e) => { if (e.target.closest('[data-net-retry]')) retry(); });
    document.querySelector('header.top')?.after(bar) ?? document.body.prepend(bar);
  }
  bar.dataset.state = next;
  bar.innerHTML = `<span>${t(`net.${next}`)}</span><button class="link" data-net-retry>${t('net.retry')}</button>`;
  scheduleProbe();
}

function scheduleProbe() {
  clearTimeout(probe);
  probe = setTimeout(async () => {
    const ok = await ping();
    if (ok) { show('ok'); return; }
    probeEvery = Math.min(probeEvery * 1.5, 60_000);
    scheduleProbe();
  }, probeEvery);
}

// /api/health skips the phone's copies (sw.js), so only the real server answers it.
async function ping() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    return r.ok;
  } catch { return false; }
}

async function retry() {
  if (bar) bar.querySelector('span').textContent = t('net.checking');
  if (await ping()) {
    show('ok');
    window.dispatchEvent(new Event('seferehov:navigate')); // the screen loads again with fresh data
  } else {
    const s = state;
    state = '';
    show(s || 'down');
  }
}

// api.js wraps every request with this.
// Uploads (slow by nature) do not count as slow.
export async function watched(promise, { upload = false } = {}) {
  pending++;
  const slow = upload ? null : setTimeout(() => { if (state === 'ok') show('slow'); }, SLOW_MS);
  try {
    const res = await promise;
    if (res.headers.get('X-Seferehov-Cached')) show('stale');
    else show('ok');
    return res;
  } catch (err) {
    // Aborted by the screen itself (it was closed) is not a server problem.
    if (err?.name !== 'AbortError') show(navigator.onLine ? 'down' : 'offline');
    throw err;
  } finally {
    clearTimeout(slow);
    pending--;
    if (!pending && state === 'slow') show('ok');
  }
}

export const serverOk = () => state === 'ok';

addEventListener('offline', () => show('offline'));
addEventListener('online', () => { if (state === 'offline') { state = ''; show('down'); retry(); } });
