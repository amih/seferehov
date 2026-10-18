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

  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });

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
    me = api('/api/me').then((r) => r.user).catch(() => null);
    me.then((u) => { if (u?.trust_level >= 3) dontTrackThisDevice(); });
  }
  return me;
}
