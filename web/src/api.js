import { dontTrackThisDevice } from './analytics.js';
import { checkForUpdate, maybeApply } from './update.js';
import { watched } from './net.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', json, form, timeout = null } = {}) {
  const headers = { 'X-App-Build': String(__APP_BUILD__) };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;

  // A request that hangs (a weak phone signal) must not hold up the screen or the menu
  // forever; uploads get longer.
  // A timeout counts as offline (a TypeError, like a failed fetch): uploads are then saved for later.
  const res = await watched(fetch(path, { method, headers, body, credentials: 'same-origin', signal: AbortSignal.timeout(timeout ?? (form ? 300_000 : 20_000)) }), { upload: !!form })
    .catch((err) => { throw err.name === 'TimeoutError' ? new TypeError('timeout') : err; });

  const serverVersion = res.headers.get('X-App-Version');
  if (serverVersion && serverVersion !== __APP_VERSION__) checkForUpdate();
  if (res.status === 426) {
    checkForUpdate();
    maybeApply();
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// The reader as last seen, kept on the phone: a screen does not wait for the server to
// know who is signed in (a slow or unreachable server showed "signed out" and no Google button).
// The server's answer replaces it when it comes.
const ME_KEY = 'seferehov:me';
const known = () => { try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch { return null; } };
function remember(u) {
  try { if (u) localStorage.setItem(ME_KEY, JSON.stringify(u)); else localStorage.removeItem(ME_KEY); } catch { /* private mode */ }
}

let me;
export async function getMe(force = false) {
  if (!me || force) {
    // A failed request (no network) is not remembered as "signed out": the next call asks again.
    const asked = api('/api/me').then((r) => { remember(r.user); return r.user; })
      .catch((err) => { if (err instanceof TypeError) { me = null; return known(); } return null; });
    me = asked;
    asked.then((u) => { if (u?.trust_level >= 3) dontTrackThisDevice(); });
  }
  if (force) return me;
  const k = known();
  return k ? Promise.race([me, new Promise((r) => setTimeout(() => r(k), 1500))]) : me;
}

// Sign-out: nothing the phone kept for this reader stays behind.
export async function forgetReader() {
  remember(null);
  try { localStorage.removeItem('todo-counts'); } catch { /* private mode */ }
  me = null;
  await caches?.delete('api').catch(() => {});
}
