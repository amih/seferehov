import { get, set, del, keys, update, createStore } from 'idb-keyval';

// Store and forward: every photo (and every upload made in the street) is written to
// the phone first (IndexedDB), and sent from there. Nothing that was taken is held only
// in memory, and nothing is dropped when sending fails:
//   - no signal, a timeout, the server busy or restarting (5xx, 429): kept, tried again
//     later (sooner when the phone comes back online or the app is opened again);
//   - signed out (401): kept until the reader signs in; app too old (426): kept, sent by
//     the updated app;
//   - refused (another 4xx): kept as "not sent" with the reason (shown in the badge),
//     tried again when the app starts, up to MAX_TRIES. Uploads that the reader watches
//     being refused (keepFailed: false, e.g. a mistyped ISBN) are dropped instead.
// Each item has an id, sent as X-Upload-Id: the server answers a repeat with its first
// answer (server/src/receipts.js), so an upload whose answer was lost is never doubled.
// A batch being taken (the shelf camera's photos, a book's two covers) is "held": stored
// as each photo is taken, sent once released. Held by a page that is gone (closed,
// reloaded, crashed) for HOLD_MS: released by itself.
// The service worker sends too (Background Sync, sw.js): an upload left when the app is
// closed goes as soon as the phone has signal. This file must therefore not touch the page.
const store = createStore('seferehov-queue', 'requests');
const PAGE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOLD_MS = 3 * 60_000;
const MAX_TRIES = 6;
const listeners = new Set();     // fn({ waiting, failed })
const itemListeners = new Map(); // id → Set of fn(state, info)
const live = new Set();          // held by this page

export const onQueueChange = (fn) => { listeners.add(fn); counts().then(fn); return () => listeners.delete(fn); };
// state: 'stored' | 'sending' | 'sent' (info = the server's answer) | 'waiting' (info = 'offline' | 'signin' | 'server') | 'failed' (info = reason)
export function onItem(id, fn) {
  if (!itemListeners.has(id)) itemListeners.set(id, new Set());
  itemListeners.get(id).add(fn);
  return () => itemListeners.get(id)?.delete(fn);
}
function emit(id, state, info) {
  itemListeners.get(id)?.forEach((fn) => { try { fn(state, info); } catch {} });
  if (state === 'sent' || (state === 'failed' && info?.dropped)) itemListeners.delete(id);
  if (typeof self.clients !== 'undefined' && self.clients.matchAll) { // the service worker tells the pages
    self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'outbox', id, state, info })));
  }
}

async function all() {
  try { return (await Promise.all((await keys(store)).sort().map((k) => get(k, store)))).filter(Boolean); } catch { return []; }
}
async function counts() {
  const items = await all();
  return { waiting: items.filter((i) => !i.failed).length, failed: items.filter((i) => i.failed).length };
}
const notify = async () => { const c = await counts(); listeners.forEach((fn) => fn(c)); };
// Waiting (not refused) uploads.
export const pendingCount = async () => (await counts()).waiting;
// Sending now, or a batch being taken on this page: the app must not reload under it.
export const busy = () => flushing || live.size > 0;

// fields: plain values; files: { name: Blob }. alt: { url, fields } to send instead when
// the server answers 404 book_not_found (a barcode no catalogue knows: send the covers).
export async function enqueue(url, fields, files = {}, label = 'upload', { alt = null, keepFailed = true, hold = false } = {}) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await set(id, { id, url, fields, files, label, alt, keepFailed, createdAt: Date.now(), tries: 0, nextAt: 0,
    hold, holder: hold ? PAGE : null, heldAt: hold ? Date.now() : null }, store);
  if (hold) live.add(id);
  navigator.storage?.persist?.().catch(() => {});
  emit(id, 'stored');
  notify();
  if (!hold) kick();
  return id;
}

// Adds files to a held batch. False if it is no longer held (released meanwhile): the
// caller starts a new one.
export async function append(id, files) {
  let ok = false;
  await update(id, (it) => {
    if (!it?.hold) return it;
    ok = true;
    return { ...it, files: { ...it.files, ...files }, heldAt: Date.now() };
  }, store);
  return ok;
}
export async function removeFiles(id, names) {
  await update(id, (it) => {
    if (!it) return it;
    const files = { ...it.files };
    names.forEach((n) => delete files[n]);
    return { ...it, files };
  }, store);
}
// Sends a held batch, with its final address and fields if they changed (a barcode read meanwhile).
export async function release(id, change = {}) {
  live.delete(id);
  await update(id, (it) => (it ? { ...it, ...change, hold: false } : it), store);
  kick();
}
export async function discard(id) {
  live.delete(id);
  await del(id, store);
  itemListeners.delete(id);
  notify();
}

let flushing = false, asked = false, timer = null;
// Soon, and again later while anything waits.
export function kick(ms = 0) {
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(() => {}), ms);
  if (ms === 0 && typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then((r) => r.sync?.register('outbox')).catch(() => {});
  }
}

const backoff = (tries) => Math.min(15 * 60_000, 15_000 * 2 ** Math.min(tries, 6));

// One pass over the waiting uploads, oldest first. Returns the answers sent in this pass,
// and whether some still wait for a reason that should clear by itself (for the service worker).
export async function flush({ failed: retryFailed = false } = {}) {
  if (flushing || asked) return { results: [], pending: true };
  const run = async () => {
    asked = false;
    flushing = true;
    const results = [];
    let pending = false, next = Infinity;
    try {
      for (const it of await all()) {
        const now = Date.now();
        if (it.hold) {
          if (live.has(it.id) || now - it.heldAt < (it.holder === PAGE ? Infinity : HOLD_MS)) { pending = true; next = Math.min(next, HOLD_MS); continue; }
          it.hold = false; // its page is gone
        }
        if (it.failed && !(retryFailed && (it.tries ?? 0) < MAX_TRIES)) continue;
        if (!it.failed && it.nextAt > now) { pending = true; next = Math.min(next, it.nextAt - now); continue; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { pending = true; emit(it.id, 'waiting', 'offline'); break; }
        const outcome = await sendOne(it);
        if (outcome.sent) { results.push({ item: it, status: outcome.status, data: outcome.data }); continue; }
        if (outcome.stop) { pending = true; next = Math.min(next, outcome.retryIn ?? 30_000); break; }
      }
    } finally {
      flushing = false;
      notify();
    }
    if (next < Infinity && typeof self.document !== 'undefined') kick(Math.max(5_000, next));
    return { results, pending };
  };
  // One sender at a time across the app's pages and its service worker.
  if (!navigator.locks?.request) return run();
  asked = true;
  return navigator.locks.request('seferehov-outbox', run).finally(() => { asked = false; });
}

async function sendOne(it) {
  const form = new FormData();
  for (const [k, v] of Object.entries(it.fields ?? {})) if (v != null) form.append(k, v);
  for (const [k, blob] of Object.entries(it.files ?? {})) if (blob) form.append(k, blob, `${k}.jpg`);
  emit(it.id, 'sending');
  let res;
  try {
    res = await fetch(it.url, { method: 'POST', body: form, credentials: 'same-origin', signal: AbortSignal.timeout(300_000),
      headers: { 'X-App-Build': String(__APP_BUILD__), 'X-Upload-Id': it.id } });
  } catch {
    await save(it, { tries: (it.tries ?? 0) + 1, nextAt: Date.now() + backoff(it.tries ?? 0), hold: false });
    emit(it.id, 'waiting', 'offline');
    return { stop: true, retryIn: backoff(it.tries ?? 0) };
  }
  const data = await res.json().catch(() => null);
  if (res.ok) {
    await del(it.id, store);
    live.delete(it.id);
    emit(it.id, 'sent', data);
    return { sent: true, status: res.status, data };
  }
  if (res.status === 404 && data?.error === 'book_not_found' && it.alt) {
    // A barcode no catalogue knows: the covers go to be read instead (straight away).
    const next = { ...it, url: it.alt.url, fields: it.alt.fields, alt: null, hold: false };
    await set(it.id, next, store);
    return sendOne(next);
  }
  if (res.status === 401) { await save(it, { hold: false }); emit(it.id, 'waiting', 'signin'); return { stop: true, retryIn: 60_000 }; }
  if (res.status === 426) { await save(it, { hold: false }); emit(it.id, 'waiting', 'server'); return { stop: true, retryIn: 60_000 }; }
  if (res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 425) {
    await save(it, { tries: (it.tries ?? 0) + 1, nextAt: Date.now() + backoff(it.tries ?? 0), hold: false });
    emit(it.id, 'waiting', 'server');
    return { stop: true, retryIn: backoff(it.tries ?? 0) };
  }
  const reason = data?.error || `HTTP ${res.status}`;
  if (!it.keepFailed) {
    await del(it.id, store);
    emit(it.id, 'failed', { reason, status: res.status, data, dropped: true });
    return { sent: false, status: res.status, data };
  }
  await save(it, { failed: true, error: reason, tries: (it.tries ?? 0) + 1, hold: false });
  emit(it.id, 'failed', { reason, status: res.status, data });
  return { sent: false, status: res.status, data };
}
const save = (it, change) => set(it.id, { ...it, ...change }, store);

// Not sent: what and why (for the badge's list), and removing one the reader gives up on.
export const failedItems = async () => (await all()).filter((i) => i.failed);
export async function retryFailed() {
  for (const it of await failedItems()) await save(it, { failed: false, nextAt: 0 });
  kick();
}

export function startQueue() {
  window.addEventListener('online', () => kick());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
  // Sent by the service worker while this page was open: the same events here.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type !== 'outbox') return;
    itemListeners.get(e.data.id)?.forEach((fn) => { try { fn(e.data.state, e.data.info); } catch {} });
    notify();
  });
  flush({ failed: true }).catch(() => {});
}
