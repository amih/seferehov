// Requests to other people's catalogues (National Library, Open Library, Google Books), so
// that a busy day never gets the server blocked: requests to one host start at least GAP ms
// apart, at most MAX_WAITING wait their turn (the rest fail at once with Busy), and a host
// that answers 429 or 503 is left alone for its Retry-After, or 1, 2, 4… up to 30 minutes.
// A lookup that hits Busy is treated as "not available now", never as "not found".
const GAP = { 'openlibrary.org': 1000, 'covers.openlibrary.org': 1000, 'nli.alma.exlibrisgroup.com': 1500, 'www.googleapis.com': 1000 };
const DEFAULT_GAP = 1000;
const MAX_WAITING = 30;
const COOL_MIN = 60_000, COOL_MAX = 30 * 60_000;

export class Busy extends Error {
  constructor(host, why, resting) { super(`${host}: ${why}`); this.busy = true; this.resting = resting; }
}

const hosts = new Map(); // host → { next: time of the next free slot, waiting, coolUntil, strikes }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function politeFetch(url, opts = {}) {
  const host = new URL(url).host;
  const h = hosts.get(host) ?? hosts.set(host, { next: 0, waiting: 0, coolUntil: 0, strikes: 0 }).get(host);
  const now = Date.now();
  if (h.coolUntil > now) throw new Busy(host, 'resting after a refusal', true);
  if (h.waiting >= MAX_WAITING) throw new Busy(host, 'too many requests waiting', false);
  const at = Math.max(now, h.next);
  h.next = at + (GAP[host] ?? DEFAULT_GAP);
  h.waiting++;
  try { await sleep(at - now); } finally { h.waiting--; }
  if (h.coolUntil > Date.now()) throw new Busy(host, 'resting after a refusal', true);
  const res = await fetch(url, opts);
  if (res.status === 429 || res.status === 503) {
    const after = Number(res.headers.get('retry-after')) * 1000;
    h.strikes++;
    h.coolUntil = Date.now() + Math.min(COOL_MAX, after > 0 ? after : COOL_MIN * 2 ** (h.strikes - 1));
  } else if (res.ok) h.strikes = 0;
  return res;
}

// For /admin and tests: which hosts are resting now.
export const politeState = () => [...hosts].map(([host, h]) => ({ host, waiting: h.waiting, restingFor: Math.max(0, h.coolUntil - Date.now()) }));
