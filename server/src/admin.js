// /admin: what search engines can find (the public pages, as lists), cover texts that
// wait for a check before they are shown, how the app is used (counts), and the readers
// themselves: who joined, when they were last in, and what they did. Visitor numbers
// come from Matomo when MATOMO_TOKEN is set.
import { config } from './config.js';
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { bookPath, SITEMAP_BOOKS_SQL } from './seo.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { listTraces, readTrace, traceFilePath } from './trace.js';
import { traceUpload } from './scans.js';

const ADMIN = 3;
const DAYS = 30;

// Each list is what the sitemap holds; the counts say how many pages of each kind exist.
async function seoPages() {
  const countries = await many(
    `SELECT p.country AS cc, count(*)::int AS n FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' GROUP BY 1 ORDER BY n DESC`);
  const places = await many(
    `SELECT p.id, p.slug, p.name, p.name_he, p.country, count(*)::int AS n
       FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' GROUP BY p.id ORDER BY n DESC LIMIT 300`);
  const { n: placeCount } = await one(
    `SELECT count(DISTINCT place_id)::int AS n FROM locations WHERE status = 'approved' AND place_id IS NOT NULL`);
  const { n: libCount } = await one(`SELECT count(*)::int AS n FROM locations WHERE status = 'approved'`);
  // Libraries with books first: those are the pages worth reading.
  const libraries = await many(
    `SELECT l.code, l.name, p.name AS place, p.name_he AS place_he, count(DISTINCT s.book_id)::int AS books, max(s.created_at) AS last_report
       FROM locations l LEFT JOIN places p ON p.id = l.place_id
       LEFT JOIN sightings s ON s.location_id = l.id AND s.status = 'approved'
      WHERE l.status = 'approved' AND (s.id IS NOT NULL OR l.created_by IS NOT NULL)
      GROUP BY l.id, p.id ORDER BY books DESC, last_report DESC NULLS LAST LIMIT 300`);
  const books = await many(
    `SELECT x.id, x.title, x.lastmod, b.authors, b.isbn13, b.danacode,
            (b.front_url IS NOT NULL OR b.cover_url IS NOT NULL) AS catalog_cover, b.description IS NOT NULL AS blurb,
            (SELECT count(*)::int FROM photos p WHERE p.ocr_status IN ('auto', 'approved') AND p.id IN (
               SELECT unnest(ARRAY[s.photo_id, s.back_photo_id]) FROM sightings s WHERE s.book_id = x.id
               UNION SELECT unnest(ARRAY[m.photo_id, m.back_photo_id]) FROM my_books m WHERE m.book_id = x.id)) AS texts
       FROM (${SITEMAP_BOOKS_SQL}) x JOIN books b ON b.id = x.id
      ORDER BY x.lastmod DESC NULLS LAST LIMIT 500`);
  const { n: bookCount } = await one(`SELECT count(*)::int AS n FROM (${SITEMAP_BOOKS_SQL}) x`);
  return {
    counts: { countries: countries.length, places: placeCount, libraries: libCount, books: bookCount },
    countries, places, libraries,
    books: books.map((b) => ({ ...b, path: bookPath(b) })),
    sitemap: `${config.baseUrl}/sitemap.xml`,
  };
}

// Day by day for the last 30 days, plus totals. Counts only.
async function activity() {
  const daily = await many(
    `WITH days AS (SELECT generate_series(current_date - ${DAYS - 1}, current_date, '1 day')::date AS d)
     SELECT d AS day,
       (SELECT count(*) FROM users WHERE created_at::date = d)::int AS new_readers,
       (SELECT count(DISTINCT user_id) FROM (
          SELECT user_id FROM scans WHERE created_at::date = d
          UNION ALL SELECT user_id FROM sightings WHERE created_at::date = d
          UNION ALL SELECT user_id FROM my_books WHERE created_at::date = d) a)::int AS active_readers,
       (SELECT count(*) FROM scans WHERE created_at::date = d)::int AS scans,
       (SELECT count(*) FROM sightings WHERE created_at::date = d)::int AS reports,
       (SELECT count(*) FROM my_books WHERE created_at::date = d)::int AS home_books,
       (SELECT count(*) FROM locations WHERE created_at::date = d AND created_by IS NOT NULL)::int AS new_libraries
     FROM days ORDER BY d`);
  const totals = await one(
    `SELECT (SELECT count(*) FROM users)::int AS readers,
            (SELECT count(*) FROM locations WHERE status = 'approved')::int AS libraries,
            (SELECT count(*) FROM locations WHERE status = 'approved' AND created_by IS NOT NULL)::int AS reader_libraries,
            (SELECT count(DISTINCT book_id) FROM sightings WHERE status = 'approved')::int AS books_in_libraries,
            (SELECT count(DISTINCT book_id) FROM my_books)::int AS books_at_home,
            (SELECT count(*) FROM sightings WHERE status = 'approved')::int AS reports,
            (SELECT count(*) FROM book_watches)::int AS watches`);
  // How good the reading is: what readers did with what the photos found.
  const reading = await many(
    `SELECT s.source, count(*)::int AS items,
            count(*) FILTER (WHERE i.outcome = 'kept')::int AS kept,
            count(*) FILTER (WHERE i.outcome = 'edited')::int AS edited,
            count(*) FILTER (WHERE i.outcome = 'dropped')::int AS dropped,
            count(*) FILTER (WHERE i.isbn13 IS NOT NULL OR i.danacode IS NOT NULL)::int AS with_code
       FROM scan_items i JOIN scans s ON s.id = i.scan_id
      WHERE i.decision IS DISTINCT FROM 'merged' GROUP BY 1 ORDER BY 2 DESC`);
  // Most reported books and busiest towns: only what three or more reports agree on.
  const topBooks = await many(
    `SELECT b.id, b.title, count(*)::int AS n FROM sightings s JOIN books b ON b.id = s.book_id
      WHERE s.status = 'approved' GROUP BY b.id HAVING count(DISTINCT s.user_id) >= 3 ORDER BY n DESC LIMIT 15`);
  const topPlaces = await many(
    `SELECT p.id, p.slug, p.name, p.name_he, count(*)::int AS n FROM sightings s
       JOIN locations l ON l.id = s.location_id JOIN places p ON p.id = l.place_id
      WHERE s.status = 'approved' GROUP BY p.id HAVING count(DISTINCT s.user_id) >= 3 ORDER BY n DESC LIMIT 15`);
  return { daily, totals, reading, topBooks: topBooks.map((b) => ({ ...b, path: bookPath(b) })), topPlaces };
}

// ---- Matomo (view-only token for the Seferehov site), cached for 10 minutes
let matomoCache = { at: 0, value: null };
async function matomo() {
  const { url, siteId, token } = config.matomo;
  if (!url || !siteId || !token) return null;
  if (matomoCache.at > Date.now() - 600_000) return matomoCache.value;
  const call = async (method, extra = {}) => {
    const body = new URLSearchParams({ module: 'API', method, idSite: siteId, format: 'JSON', token_auth: token, ...extra });
    const res = await fetch(`${url}/index.php`, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
    const json = await res.json();
    if (json?.result === 'error') throw new Error(json.message);
    return json;
  };
  const range = { period: 'range', date: `last${DAYS}` };
  try {
    const [days, pages, referrers, countries] = await Promise.all([
      call('VisitsSummary.get', { period: 'day', date: `last${DAYS}` }),
      call('Actions.getPageUrls', { ...range, flat: '1', filter_limit: '25', filter_sort_column: 'nb_hits' }),
      call('Referrers.getReferrerType', range),
      call('UserCountry.getCountry', { ...range, filter_limit: '10' }),
    ]);
    const value = {
      days: Object.entries(days).map(([day, v]) => ({ day, visits: v.nb_visits ?? 0, actions: v.nb_actions ?? 0 })),
      pages: pages.map((p) => ({ url: p.label, hits: p.nb_hits, visits: p.nb_visits })),
      referrers: referrers.map((r) => ({ type: r.label, visits: r.nb_visits })),
      countries: countries.map((c) => ({ country: c.label, code: c.code, visits: c.nb_visits })),
    };
    matomoCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    return { error: err.message };
  }
}

// Every reader, newest first, with what they did. "Last in" is the later of their last
// visit while signed in and their last report, scan, home book or review.
async function readers() {
  return many(
    `SELECT u.id, u.screen_name, u.email, u.trust_level, u.created_at, u.google_sub IS NOT NULL AS google,
            GREATEST(u.last_seen_at, a.last_act) AS last_seen,
            COALESCE(k.karma, 0)::int AS karma, COALESCE(k.week, 0)::int AS week_points,
            a.scans, a.reports, a.home_books, a.reviews, a.libraries, a.watches,
            (SELECT count(*) FROM push_subs p WHERE p.user_id = u.id)::int AS phones
       FROM users u
       LEFT JOIN (SELECT user_id, sum(points) AS karma, sum(points) FILTER (WHERE created_at > now() - interval '7 days') AS week
                    FROM karma_events GROUP BY 1) k ON k.user_id = u.id
       CROSS JOIN LATERAL (SELECT
            (SELECT count(*) FROM scans WHERE user_id = u.id)::int AS scans,
            (SELECT count(*) FROM sightings WHERE user_id = u.id)::int AS reports,
            (SELECT count(*) FROM my_books WHERE user_id = u.id)::int AS home_books,
            (SELECT count(*) FROM book_reviews WHERE user_id = u.id)::int AS reviews,
            (SELECT count(*) FROM locations WHERE created_by = u.id)::int AS libraries,
            (SELECT count(*) FROM book_watches WHERE user_id = u.id)::int AS watches,
            (SELECT max(t) FROM (SELECT max(created_at) t FROM scans WHERE user_id = u.id
               UNION ALL SELECT max(created_at) FROM sightings WHERE user_id = u.id
               UNION ALL SELECT max(created_at) FROM my_books WHERE user_id = u.id
               UNION ALL SELECT max(updated_at) FROM book_reviews WHERE user_id = u.id) x) AS last_act) a
      ORDER BY u.created_at DESC LIMIT 500`);
}

// One reader's last 50 actions, newest first: scans, reports, home books, reviews,
// libraries added, library checks, book fixes and alerts.
async function readerActivity(userId) {
  return many(
    `SELECT * FROM (
       SELECT s.created_at AS at, 'scan' AS what, s.source || ' · ' || s.status AS detail, l.code, l.name AS place, NULL::bigint AS book_id
         FROM scans s LEFT JOIN locations l ON l.id = s.location_id WHERE s.user_id = $1
       UNION ALL SELECT s.created_at, 'report', s.kind || ' · ' || s.status, l.code, l.name, b.id
         FROM sightings s JOIN locations l ON l.id = s.location_id JOIN books b ON b.id = s.book_id WHERE s.user_id = $1
       UNION ALL SELECT m.created_at, 'home book', NULL, NULL, NULL, m.book_id FROM my_books m WHERE m.user_id = $1
       UNION ALL SELECT r.updated_at, 'review', CASE WHEN r.rating IS NOT NULL THEN r.rating || '★' END, NULL, NULL, r.book_id FROM book_reviews r WHERE r.user_id = $1
       UNION ALL SELECT l.created_at, 'new library', l.status, l.code, l.name, NULL FROM locations l WHERE l.created_by = $1
       UNION ALL SELECT c.created_at, 'library check', c.state, l.code, l.name, NULL FROM location_checks c JOIN locations l ON l.id = c.location_id WHERE c.user_id = $1
       UNION ALL SELECT f.created_at, 'book fix', f.field || ' · ' || f.status || ' · ' || left(COALESCE(f.new_value, ''), 60), NULL, NULL, f.book_id FROM book_fixes f WHERE f.user_id = $1
       UNION ALL SELECT w.created_at, 'alert', w.kind || COALESCE(' · ' || w.query, ''), NULL, NULL, w.book_id FROM book_watches w WHERE w.user_id = $1
     ) a LEFT JOIN LATERAL (SELECT title FROM books WHERE id = a.book_id) b ON true
     ORDER BY at DESC LIMIT 50`, [userId]);
}

export default async function adminRoutes(app) {
  app.get('/api/admin/readers', { preHandler: requireUser(ADMIN) }, async () => ({ readers: await readers() }));
  app.get('/api/admin/readers/:id', { preHandler: requireUser(ADMIN) }, async (req) => ({ activity: await readerActivity(Number(req.params.id)) }));

  app.get('/api/admin/overview', { preHandler: requireUser(ADMIN) }, async () => ({
    seo: await seoPages(),
    activity: await activity(),
    matomo: await matomo(),
  }));

  // Cover texts waiting for a check: Hebrew reads, and reads that looked like a loop.
  app.get('/api/admin/cover-texts', { preHandler: requireUser(ADMIN) }, async () => ({
    items: await many(
      `SELECT p.id, p.kind, p.path, p.ocr_text, p.ocr_at, b.id AS book_id, b.title
         FROM photos p
         LEFT JOIN LATERAL (
           SELECT book_id FROM sightings s WHERE p.id IN (s.photo_id, s.back_photo_id)
           UNION ALL SELECT book_id FROM my_books m WHERE p.id IN (m.photo_id, m.back_photo_id) LIMIT 1) x ON true
         LEFT JOIN books b ON b.id = x.book_id
        WHERE p.ocr_status = 'review' ORDER BY p.ocr_at DESC LIMIT 50`),
    counts: await one(
      `SELECT count(*) FILTER (WHERE ocr_status = 'review')::int AS review,
              count(*) FILTER (WHERE ocr_status IN ('auto', 'approved'))::int AS shown,
              count(*) FILTER (WHERE ocr_at IS NULL AND kind IN ('cover', 'back'))::int AS waiting
         FROM photos`),
  }));

  app.post('/api/admin/cover-texts/:id', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const { status, text } = req.body ?? {};
    if (!['approved', 'rejected'].includes(status)) return reply.code(400).send({ error: 'bad_request' });
    const r = await q(
      `UPDATE photos SET ocr_status = $2, ocr_text = COALESCE($3, ocr_text) WHERE id = $1 AND ocr_text IS NOT NULL`,
      [req.params.id, status, typeof text === 'string' ? text.trim().slice(0, 8000) : null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Traces (/admin/trace): what every stage of reading a scan or a cover did.
  app.get('/api/admin/traces', { preHandler: requireUser(ADMIN) }, async () => ({ traces: await listTraces() }));
  app.get('/api/admin/traces/:id', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const trace = await readTrace(req.params.id);
    if (!trace) return reply.code(404).send({ error: 'not_found' });
    // A real scan: what went to the queue, and what the reader decided.
    const items = /^[0-9a-f-]{36}$/.test(req.params.id) ? await many(
      `SELECT i.id, i.title, i.author, i.quality, i.decision, i.outcome, i.matched, i.crop_path, b.title AS book_title
         FROM scan_items i LEFT JOIN books b ON b.id = i.book_id WHERE i.scan_id = $1 ORDER BY i.id`, [req.params.id]) : [];
    return { trace, items };
  });
  // Pictures and the video; the video answers Range requests so it can be scrubbed.
  app.get('/api/admin/traces/:id/:file', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const path = traceFilePath(req.params.id, req.params.file);
    const size = path && await stat(path).then((x) => x.size, () => null);
    if (!size) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', path.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg').header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=86400');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!m) return reply.header('content-length', size).send(createReadStream(path));
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
      .send(createReadStream(path, { start, end }));
  });
  // A test upload: read the same way as a reader's, with nothing saved but the trace.
  app.post('/api/admin/traces', { preHandler: requireUser(ADMIN), bodyLimit: 101 * 1024 * 1024 }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart_required' });
    const files = [];
    let source = 'photo';
    for await (const part of req.parts({ limits: { files: 8, fileSize: 100 * 1024 * 1024 } })) {
      if (part.type !== 'file') { if (part.fieldname === 'source') source = part.value; continue; }
      const video = part.mimetype?.startsWith('video/') || /\.(mp4|mov|webm|m4v|3gp)$/i.test(part.filename ?? '');
      files.push({ name: part.filename, video, buffer: await part.toBuffer() });
    }
    if (!files.length) return reply.code(400).send({ error: 'no_media' });
    if (source === 'cover') files.splice(2);
    else source = files.some((f) => f.video) ? 'video' : 'photo';
    return { id: traceUpload(files, source) };
  });
}
