// IndexNow: every 15 minutes, the book, shelf-photo, library and town pages that changed since the last
// push are sent to api.indexnow.org, which shares them with Bing, Yandex, Seznam, Naver and
// others (Google does not take part; it reads the sitemap). Same pages as the sitemap: what
// gets noindex there is not pushed here. The key file is served by seo.js at /<key>.txt.
import { config } from './config.js';
import { one, many, q } from './db.js';
import { bookPath, shelfPath, doubtfulBooks, SITEMAP_BOOKS_SQL, SHELVES_SQL, LIB_INDEXED, LIB_LASTMOD } from './seo.js';

const EVERY_MS = 15 * 60_000;
const BATCH = 10_000; // IndexNow's limit per request
const STATE = 'indexnow_pushed_at';

async function changedUrls(since) {
  const books = await many(`SELECT * FROM (${SITEMAP_BOOKS_SQL}) x WHERE lastmod > $1`, [since]);
  const doubtful = await doubtfulBooks(books.map((b) => b.id));
  const libs = await many(
    `SELECT l.code, p.id AS pid, p.slug FROM locations l LEFT JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' AND ${LIB_INDEXED} AND ${LIB_LASTMOD} > $1`, [since]);
  const shelves = await many(`SELECT id FROM (${SHELVES_SQL}) x WHERE lastmod > $1`, [since]);
  const places = new Map(libs.filter((l) => l.pid).map((l) => [l.pid, `/p/${l.pid}-${l.slug}`]));
  return [
    ...books.filter((b) => !doubtful.has(Number(b.id))).map(bookPath),
    ...libs.map((l) => `/l/${l.code}`),
    ...shelves.map((r) => shelfPath(r.id)),
    ...places.values(),
  ].map((p) => config.baseUrl + p);
}

async function submit(urls) {
  const host = new URL(config.baseUrl).host;
  for (let i = 0; i < urls.length; i += BATCH) {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: config.indexNowKey, keyLocation: `${config.baseUrl}/${config.indexNowKey}.txt`, urlList: urls.slice(i, i + BATCH) }),
      signal: AbortSignal.timeout(30_000),
    });
    // 200 = taken, 202 = taken, key check pending. Anything else: try again next round.
    if (![200, 202].includes(res.status)) throw new Error(`IndexNow ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export async function pushChanged(log) {
  const started = new Date();
  // First run: everything (epoch); later runs: since the last push that went through.
  const since = (await one(`SELECT value FROM app_state WHERE key = $1`, [STATE]))?.value ?? '1970-01-01';
  const urls = await changedUrls(since);
  if (urls.length) await submit(urls);
  await q(`INSERT INTO app_state(key, value) VALUES ($1, to_jsonb($2::text))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [STATE, started.toISOString()]);
  if (urls.length) log.info({ n: urls.length, since }, 'indexnow: pushed');
  return urls.length;
}

export function startIndexNow(log) {
  if (!config.indexNowKey || !config.baseUrl.startsWith('https://')) return;
  const run = () => pushChanged(log).catch((err) => log.warn({ err: err.message }, 'indexnow'));
  setTimeout(run, 2 * 60_000).unref();
  setInterval(run, EVERY_MS).unref();
}
