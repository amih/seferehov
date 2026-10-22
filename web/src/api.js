import { dontTrackThisDevice } from './analytics.js';
import { checkForUpdate, maybeApply } from './update.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', json, form } = {}) {
  const headers = { 'X-App-Build': String(__APP_BUILD__) };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;

  // A request that hangs (a weak phone signal) must not hold up the screen or the menu
  // forever; uploads get longer.
  // A timeout counts as offline (a TypeError, like a failed fetch): uploads are then saved for later.
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: AbortSignal.timeout(form ? 300_000 : 20_000) })
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

let me;
export async function getMe(force = false) {
  if (!me || force) {
    // A failed request (no network) is not remembered as "signed out": the next call asks again.
    me = api('/api/me').then((r) => r.user).catch((err) => { if (err instanceof TypeError) me = null; return null; });
    me.then((u) => { if (u?.trust_level >= 3) dontTrackThisDevice(); });
  }
  return me;
}
