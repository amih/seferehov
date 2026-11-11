// The whole app, end to end: a fresh database with every migration, the real server, and a
// headless browser that opens every screen as a visitor, a reader and an admin, in Hebrew
// and English. A screen fails when the page throws, logs an error, gets a server error
// (5xx) from the API, or is still on "Loading…" after a few seconds (the to-do tabs bug of
// 11 Nov 2026). Every GET endpoint of the API is also called (any 5xx fails).
//
//   npm run test:e2e    (needs Docker for the database, or TEST_DATABASE_URL; and Chromium:
//                        npx playwright install chromium)
// Nothing outside is asked (NO_OUTSIDE=1: no catalogues, no vision model, no mail).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const SETTLE_MS = Number(process.env.E2E_SETTLE_MS ?? 6000);
const freePort = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dbUrl, container, server, serverLog = '', base, browser, tmp;
const S = {}; // seeded ids and session tokens

async function startDb() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const port = await freePort();
  container = `seferehov-e2e-${process.pid}`;
  execFileSync('docker', ['run', '-d', '--rm', '--name', container, '-e', 'POSTGRES_DB=seferehov', '-e', 'POSTGRES_USER=seferehov',
    '-e', 'POSTGRES_PASSWORD=seferehov', '-p', `127.0.0.1:${port}:5432`, 'postgis/postgis:16-3.4-alpine'], { stdio: 'ignore' });
  const url = `postgres://seferehov:seferehov@127.0.0.1:${port}/seferehov`;
  for (let i = 0; i < 90; i++) {
    const c = new pg.Client(url);
    try { await c.connect(); await c.query('SELECT postgis_version()'); await c.end(); await sleep(1000); return url; } catch { await c.end().catch(() => {}); await sleep(1000); }
  }
  throw new Error('test database did not start');
}

async function seed() {
  const c = new pg.Client(dbUrl);
  await c.connect();
  const one = async (sql, args) => (await c.query(sql, args)).rows[0];
  const session = async (userId) => {
    const token = randomBytes(24).toString('hex');
    await c.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [createHash('sha256').update(token).digest(), userId]);
    return token;
  };
  S.admin = (await one(`INSERT INTO users(email, screen_name, trust_level) VALUES ('admin@example.com', 'Admin', 3) RETURNING id`)).id;
  S.reader = (await one(`INSERT INTO users(email, screen_name, trust_level) VALUES ('reader@example.com', 'Reader', 0) RETURNING id`)).id;
  S.adminToken = await session(S.admin);
  S.readerToken = await session(S.reader);
  S.code = 'TEST01';
  S.location = (await one(`INSERT INTO locations(code, name, geom, status, created_by)
    VALUES ($1, 'Test library', ST_SetSRID(ST_MakePoint(34.78, 32.08), 4326), 'approved', $2) RETURNING id`, [S.code, S.reader])).id;
  await c.query(`INSERT INTO locations(code, name, geom, status, source) VALUES ('OSM001', 'Open-data library', ST_SetSRID(ST_MakePoint(34.7801, 32.0801), 4326), 'approved', 'osm')`);
  S.book = (await one(`INSERT INTO books(title, authors, source, isbn13) VALUES ('אני הורג', ARRAY['ג''ורג''ו פאלטי'], 'test', '9789650000001') RETURNING id`)).id;
  S.book2 = (await one(`INSERT INTO books(title, authors, source) VALUES ('Deep Work', ARRAY['Cal Newport'], 'test') RETURNING id`)).id;
  S.sighting = (await one(`INSERT INTO sightings(book_id, location_id, user_id, kind, status) VALUES ($1, $2, $3, 'seen', 'approved') RETURNING id`, [S.book, S.location, S.reader])).id;
  await c.query(`INSERT INTO sightings(book_id, location_id, user_id, kind, status) VALUES ($1, $2, $3, 'seen', 'pending')`, [S.book2, S.location, S.reader]);
  S.myBook = (await one(`INSERT INTO my_books(user_id, book_id) VALUES ($1, $2) RETURNING id`, [S.reader, S.book2])).id;
  // A read scan with one book waiting for the reader's approval. (No scan in line: the real
  // scan worker would try to read its photo.)
  S.scan = (await one(`INSERT INTO scans(user_id, location_id, status, source, media, started_at, finished_at)
    VALUES ($1, $2, 'done', 'photo', '[{"path":"0.img","type":"image"}]', now() - interval '5 minutes', now()) RETURNING id`, [S.reader, S.location])).id;
  await c.query(`INSERT INTO scan_items(scan_id, title, author, via, book_id, confidence, quality) VALUES ($1, 'Deep Work', 'Cal Newport', 'vision', $2, 85, 'medium')`, [S.scan, S.book2]);
  await c.end();
}

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const dead = 'http://127.0.0.1:9'; // nothing listens: the vision model and OCR are "down"
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_URL: base, DATABASE_URL: dbUrl,
    WEB_DIST: join(ROOT, 'web/dist'), UPLOAD_DIR: join(tmp, 'uploads'), TRACE_DIR: join(tmp, 'trace'),
    OLLAMA_URL: dead, OCR_URL: dead, SEARCH_URL: '', SMTP_HOST: '', NOTIFY_ADMIN_MINUTES: '0', TRACE: '0',
    GOOGLE_CLIENT_ID: '', MATOMO_URL: '', NO_OUTSIDE: '1', SERVE_WEB: '1', ADMIN_EMAILS: 'admin@example.com', NODE_ENV: 'test',
  };
  execFileSync('node', ['src/migrate.js'], { cwd: join(ROOT, 'server'), env, stdio: 'ignore' });
  await seed();
  server = spawn('node', ['src/index.js'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode != null) throw new Error(`server exited:\n${serverLog.slice(-3000)}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error(`server did not start:\n${serverLog.slice(-3000)}`);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'seferehov-e2e-'));
  readdirSync(join(ROOT, 'web/dist')); // the build must exist (npm run build)
  dbUrl = await startDb();
  await startServer();
  // E2E_CHANNEL=chrome: the Chrome already installed (GitHub's runners have one).
  browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
}, { timeout: 180_000 });

after(async () => {
  await browser?.close();
  server?.kill();
  if (container) { try { execFileSync('docker', ['stop', container], { stdio: 'ignore' }); } catch { /* gone */ } }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Server log lines at error level (pino level 50+), e.g. a route that threw.
const serverErrors = () => serverLog.split('\n').filter((l) => /"level":(50|60)/.test(l));

// --- The API: every GET route, as a visitor, a reader and an admin. -----------------------

function apiPaths() {
  const src = readdirSync(join(ROOT, 'server/src')).filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(ROOT, 'server/src', f), 'utf8')).join('\n');
  const paths = [...new Set([...src.matchAll(/app\.get\(\s*'([^']+)'/g)].map((m) => m[1]))];
  const value = { code: S.code, id: '1', file: 'x.jpg', name: 'books.xml' };
  return paths.filter((p) => !p.startsWith('/api/auth/google')).map((p) => p.replace(/:(\w+)/g, (_, k) =>
    (k === 'id' && p.includes('/books/') ? String(S.book) : k === 'id' && p.includes('/my-books/') ? String(S.myBook)
      : k === 'id' && /queue|scans/.test(p) ? S.scan : value[k] ?? '1')));
}
const EXTRA = () => [
  `/api/locations?bbox=34.7,32.0,34.9,32.2&zoom=14&px=800`, `/api/books/search?q=deep`, `/api/books/search?q=אני`,
  `/api/books/lookup?isbn=9789650000001`, `/api/places/search?q=tel`, `/api/libraries/need-help?lat=32.08&lon=34.78`,
  `/api/locations/${S.code}/books/${S.book}`, `/b/${S.book}`, `/l/${S.code}`, `/places`, '/c/il', '/sitemap.xml',
];

for (const who of ['visitor', 'reader', 'admin']) {
  test(`API: no server errors (${who})`, async () => {
    const cookie = who === 'visitor' ? '' : `seferehov_session=${who === 'admin' ? S.adminToken : S.readerToken}`;
    const failed = [];
    for (const p of [...apiPaths(), ...EXTRA()]) {
      const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
      if (res.status >= 500) failed.push(`${res.status} ${p}: ${(await res.text()).slice(0, 200)}`);
    }
    assert.deepEqual(failed, []);
  });
}

// --- The screens: every route of the app, in a real browser. -------------------------------

const SCREENS = () => [
  '/', '/about', '/comic', '/search', '/top', '/login', '/places', '/c/il', `/b/${S.book}`,
  `/l/${S.code}`, `/l/${S.code}/b/${S.book}`, `/l/${S.code}/check`,
  { path: '/queue', signedIn: true }, { path: `/scan/${S.scan}`, signedIn: true },
  { path: '/books', signedIn: true }, { path: `/books/${S.myBook}`, signedIn: true }, { path: '/books/add', signedIn: true, camera: true },
  { path: '/offers', signedIn: true }, { path: '/me', signedIn: true }, { path: '/settings', signedIn: true },
  { path: '/add', signedIn: true }, { path: `/l/${S.code}/edit`, signedIn: true }, { path: `/l/${S.code}/add`, signedIn: true, camera: true },
  { path: '/fixes', signedIn: true }, { path: '/review', admin: true }, { path: '/duplicates', admin: true },
  { path: '/duplicate-libraries', admin: true }, { path: '/admin', admin: true }, { path: '/admin#queue', admin: true },
  { path: '/admin#texts', admin: true }, { path: '/admin#readers', admin: true }, { path: '/admin#camera', admin: true },
  { path: '/admin#stats', admin: true }, { path: '/admin#reviews', admin: true }, { path: '/admin/trace', admin: true },
].map((s) => (typeof s === 'string' ? { path: s } : s));

const LOADING = ['טוען…', 'Loading…'];
// Requests to other sites (map tiles, fonts) may fail in a test run; only our own count.
const ours = (url) => url.startsWith(base);

async function openScreen(context, screen) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    if (/Failed to load resource/.test(m.text()) && !ours(url)) return;
    if (/Failed to load resource/.test(m.text()) && /status of 4\d\d/.test(m.text())) return; // 401/404 are answers
    problems.push(`console: ${m.text()} ${url}`);
  });
  page.on('response', (r) => { if (ours(r.url()) && r.status() >= 500) problems.push(`${r.status()} ${r.url().slice(base.length)}`); });
  await page.goto(base + screen.path, { waitUntil: 'load' });
  // Wait for the screen to finish drawing: no "Loading…" left in the view.
  let stuck = true;
  for (let t = 0; t < SETTLE_MS; t += 250) {
    const text = await page.locator('#view').innerText().catch(() => '');
    if (text.trim() && !LOADING.some((l) => text.includes(l))) { stuck = false; break; }
    await sleep(250);
  }
  if (stuck) problems.push(`still loading after ${SETTLE_MS / 1000} s: "${(await page.locator('#view').innerText().catch(() => '')).slice(0, 120)}"`);
  // The menu opens and lists its items.
  if (!screen.camera) {
    const menu = page.locator('#menu-btn');
    if (await menu.count()) { await menu.click().catch(() => {}); await sleep(300); }
  }
  await page.close();
  return problems;
}

for (const lang of ['he', 'en']) {
  for (const who of ['visitor', 'reader', 'admin']) {
    test(`screens open without errors (${who}, ${lang})`, { timeout: 300_000 }, async () => {
      const context = await browser.newContext({
        locale: lang === 'he' ? 'he-IL' : 'en-US', serviceWorkers: 'block', permissions: [],
        viewport: { width: 400, height: 800 }, geolocation: undefined,
      });
      if (who !== 'visitor') {
        await context.addCookies([{ name: 'seferehov_session', value: who === 'admin' ? S.adminToken : S.readerToken, url: base }]);
      }
      await context.addInitScript((l) => { try { localStorage.setItem('seferehov:lang', l); } catch { /* */ } }, lang);
      const failed = [];
      for (const screen of SCREENS()) {
        if (screen.signedIn && who === 'visitor') continue;
        if (screen.admin && who !== 'admin') continue;
        const problems = await openScreen(context, screen);
        if (problems.length) failed.push(`${screen.path}\n    ${problems.join('\n    ')}`);
      }
      await context.close();
      assert.deepEqual(failed, [], `\n${failed.join('\n')}`);
    });
  }
}

test('the server logged no errors', () => {
  assert.deepEqual(serverErrors().map((l) => l.slice(0, 400)), []);
});
