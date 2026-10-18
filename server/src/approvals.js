// The reader's approval queue: books read from their photos and videos, and barcodes
// they scanned, wait here one by one until approved, declined or set aside for later.
import { config } from './config.js';
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';
import { lookupIsbn, findOrCreateBook, withCode } from './books.js';
import { missingParts } from './details.js';
import { locationByCode, visibleTo, distanceTo, splitAuthors } from './locations.js';
import { initialStatus, awardSighting } from './moderation.js';
import { parseLatLon } from './util.js';
import { readForm } from './multipart.js';
import { normTitle } from './vision.js';

const ITEM_SQL = `
  SELECT i.id, i.title, i.author, i.isbn13, i.via, i.matched, i.quality, i.frame_path, i.crop_path, i.back_path, i.decision, i.sources,
         s.id AS scan_id, s.kind, s.source, s.owner, s.friend_name, l.code, l.name AS location_name,
         b.id AS book_id, b.title AS book_title, b.authors AS book_authors, b.cover_url, b.year
    FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN books b ON b.id = i.book_id`;

const publicItem = ({ frame_path, crop_path, back_path, ...i }) => ({
  ...i, frame: frame_path && `/uploads/${frame_path}`, crop: crop_path && `/uploads/${crop_path}`, back: back_path && `/uploads/${back_path}`,
});

// A cover photo from the queue becomes a photo of the book (the same file, re-encoded already).
const photoOf = async (path, userId, kind) => path && (await one(
  'INSERT INTO photos(user_id, kind, path, thumb_path, cropped_at) VALUES ($1, $2, $3, $3, now()) RETURNING id', [userId, kind, path])).id;

async function counts(userId) {
  return one(
    `SELECT (SELECT count(*)::int FROM scan_items i JOIN scans s ON s.id = i.scan_id
              WHERE s.user_id = $1 AND s.status = 'done' AND i.decision IS NULL) AS open,
            (SELECT count(*)::int FROM scan_items i JOIN scans s ON s.id = i.scan_id
              WHERE s.user_id = $1 AND s.status = 'done' AND i.decision = 'later') AS later,
            (SELECT count(*)::int FROM scans WHERE user_id = $1 AND status IN ('queued', 'processing')) AS processing`,
    [userId],
  );
}

// Turns one queue item into a sighting. The app sends title/author only when the reader
// changed what was shown: unchanged catalogue matches keep their record, a correction
// makes (or finds) the book the reader typed. A scanned ISBN stays with its book.
export async function approveItem(item, scan, user, { title, author } = {}) {
  const edited = title != null || author != null;
  title = String(title ?? item.title).trim().slice(0, 300);
  author = String(author ?? item.author ?? '').trim().slice(0, 200);
  let book = item.book_id && !edited
    ? await one('SELECT * FROM books WHERE id = $1', [item.book_id])
    : title && await findOrCreateBook({
      title, authors: splitAuthors(author), source: item.via === 'barcode' ? 'user' : 'llm',
      isbn13: item.via === 'barcode' && !item.book_id ? item.isbn13 : null,
      danacode: item.via === 'barcode' && !item.book_id ? item.danacode : null,
    });
  if (!book) return null;
  // The scanned code goes with the book, so the next scan of it finds the book here.
  const code = scan.book_code || (scan.source === 'barcode' ? item.isbn13 || item.danacode : null);
  if (code) book = await withCode(book, code);
  // Covers photographed by the reader: kept as the book's front and back photos.
  const covers = item.sources?.includes('cover');
  const photoId = covers ? await photoOf(item.frame_path, user.id, 'cover') : null;
  const backPhotoId = covers ? await photoOf(item.back_path, user.id, 'back') : null;
  if (!scan.location_id) { // one of the reader's own books (My books)
    await q('INSERT INTO my_books(user_id, book_id, photo_id, back_photo_id, owner, friend_name) VALUES ($1, $2, $3, $4, COALESCE($5, \'mine\'), $6)',
      [user.id, book.id, photoId, backPhotoId, scan.owner, scan.friend_name]);
    return { sighting: null, book, edited };
  }
  const loc = await one('SELECT id, status FROM locations WHERE id = $1', [scan.location_id]);
  const far = scan.distance_m == null || scan.distance_m > config.maxReportDistanceM;
  const status = loc.status === 'approved' ? initialStatus(user, { far }) : 'pending';
  const sighting = await tx(async (db) => {
    const s = (await db.query(
      `INSERT INTO sightings(book_id, location_id, user_id, kind, status, distance_m, photo_id, back_photo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
      [book.id, scan.location_id, user.id, scan.kind, status, scan.distance_m, photoId, backPhotoId],
    )).rows[0];
    if (status === 'approved') {
      await awardSighting(db, { userId: user.id, locationId: scan.location_id, bookId: book.id, kind: scan.kind, sightingId: s.id });
      await db.query('UPDATE locations SET last_checked_at = now() WHERE id = $1', [scan.location_id]);
    }
    return s;
  });
  return { sighting, book, edited };
}

// A scan is finished once none of its books waits for a decision.
async function closeIfDone(scanId) {
  await q(
    `UPDATE scans SET status = 'confirmed' WHERE id = $1 AND status = 'done'
       AND NOT EXISTS (SELECT 1 FROM scan_items WHERE scan_id = $1 AND (decision IS NULL OR decision = 'later'))`,
    [scanId],
  );
}

// The same book is often found more than once: in two photos, in the video frames and
// by its barcode. Open items of one reader at one library that are the same book
// (same catalogue record, or the same title read) become one item, which keeps the
// catalogue match, the best reading, a picture, and every source that saw it.
const RANK = { high: 0, medium: 1, low: 2 };
const near = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a))));
export async function mergeDuplicates(userId) {
  const open = await many(
    `SELECT i.*, s.location_id, b.title AS book_title FROM scan_items i JOIN scans s ON s.id = i.scan_id
       LEFT JOIN books b ON b.id = i.book_id
      WHERE s.user_id = $1 AND s.status = 'done' AND (i.decision IS NULL OR i.decision = 'later')
      ORDER BY i.id`,
    [userId],
  );
  const same = (a, b) => a.location_id === b.location_id && (
    (a.book_id && a.book_id === b.book_id) || (a.isbn13 && a.isbn13 === b.isbn13) || (a.danacode && a.danacode === b.danacode)
    || [a.title, a.book_title].some((x) => [b.title, b.book_title].some((y) => near(normTitle(x), normTitle(y)))));
  const groups = [];
  for (const item of open) {
    const g = groups.find((gr) => gr.some((o) => same(o, item)));
    if (g) g.push(item); else groups.push([item]);
  }
  for (const g of groups.filter((gr) => gr.length > 1)) {
    // Keep the surest reading; fill in what it lacks from the others.
    g.sort((a, b) => (Number(!!b.book_id) - Number(!!a.book_id)) || (RANK[a.quality] - RANK[b.quality]) || (Number(!!b.crop_path) - Number(!!a.crop_path)) || (a.id - b.id));
    const [keep, ...rest] = g;
    const pick = (k) => keep[k] ?? rest.find((r) => r[k] != null)?.[k] ?? null;
    await tx(async (db) => {
      await db.query(
        `UPDATE scan_items SET author = $2, isbn13 = $3, crop_path = $4, frame_path = $5,
                sources = (SELECT array_agg(DISTINCT x) FROM unnest($6::text[]) x),
                decision = CASE WHEN $7 THEN NULL ELSE decision END, danacode = $8, back_path = $9
          WHERE id = $1`,
        [keep.id, pick('author'), pick('isbn13'), pick('crop_path'), pick('frame_path'),
          g.flatMap((x) => x.sources), g.some((x) => x.decision == null), pick('danacode'), pick('back_path')],
      );
      await db.query(`UPDATE scan_items SET decision = 'merged', merged_into = $2, decided_at = now() WHERE id = ANY($1)`, [rest.map((r) => r.id), keep.id]);
    });
    for (const scanId of new Set(rest.map((r) => r.scan_id))) await closeIfDone(scanId);
  }
}

export default async function approvalRoutes(app) {
  app.get('/api/queue/count', { preHandler: requireUser() }, async (req) => counts(req.user.id));

  // Undecided books first (oldest first), then the ones set aside for later.
  app.get('/api/queue', { preHandler: requireUser() }, async (req) => {
    await mergeDuplicates(req.user.id);
    const items = await many(
      `${ITEM_SQL}
        WHERE s.user_id = $1 AND s.status = 'done' AND (i.decision IS NULL OR i.decision = 'later')
        ORDER BY i.decision IS NOT NULL, CASE WHEN i.decision IS NULL THEN i.created_at ELSE i.decided_at END, i.id
        LIMIT 200`,
      [req.user.id],
    );
    const processing = await many(
      `SELECT s.id, s.status, s.source, s.progress, l.code, l.name AS location_name
         FROM scans s LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.user_id = $1 AND s.status IN ('queued', 'processing') ORDER BY s.created_at`,
      [req.user.id],
    );
    return { items: items.map(publicItem), processing, ...(await counts(req.user.id)) };
  });

  app.post('/api/queue/:id', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 600, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { decision, title, author } = req.body ?? {};
    if (!['approved', 'declined', 'later'].includes(decision)) return reply.code(400).send({ error: 'bad_request' });
    const item = await one(
      `SELECT i.* FROM scan_items i JOIN scans s ON s.id = i.scan_id
        WHERE i.id = $1 AND s.user_id = $2 AND s.status = 'done' AND (i.decision IS NULL OR i.decision = 'later')`,
      [Number(req.params.id), req.user.id],
    );
    if (!item) return reply.code(404).send({ error: 'not_found' });
    const scan = await one('SELECT * FROM scans WHERE id = $1', [item.scan_id]);
    let result = null;
    if (decision === 'approved') {
      result = await approveItem(item, scan, req.user, { title, author });
      if (!result) return reply.code(422).send({ error: 'title_required' });
    }
    // For the statistics: was the reading right? (declined = dropped)
    const outcome = decision === 'approved' ? (result.edited ? 'edited' : 'kept') : decision === 'declined' ? 'dropped' : null;
    await q(
      `UPDATE scan_items SET decision = $2, decided_at = now(), outcome = $3, sighting_id = $4 WHERE id = $1`,
      [item.id, decision, outcome, result?.sighting?.id ?? null],
    );
    await closeIfDone(item.scan_id);
    return { status: result?.sighting?.status ?? null, ...(await counts(req.user.id)) };
  });

  // One scanned barcode: looked up now, then waits in the queue like any other book.
  app.post('/api/locations/:code/barcode', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 300, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user) || loc.status === 'removed') return reply.code(404).send({ error: 'not_found' });
    const { isbn, kind, lat, lon, lang } = (await readForm(req)).fields; // multipart when sent from the offline queue
    const r = await lookupIsbn(String(isbn ?? ''), 'scan');
    if (r.error) return reply.code(400).send({ error: r.error });
    const book = r.book ?? null;
    const distance = await distanceTo(loc.id, parseLatLon(lat, lon));
    const item = await tx(async (db) => {
      const scan = (await db.query(
        `INSERT INTO scans(location_id, user_id, kind, source, status, distance_m, lang, started_at, finished_at, notified_at)
         VALUES ($1, $2, $3, 'barcode', 'done', $4, $5, now(), now(), now()) RETURNING id`,
        [loc.id, req.user.id, kind === 'added' ? 'added' : 'seen', distance, lang === 'en' ? 'en' : 'he'],
      )).rows[0];
      return (await db.query(
        `INSERT INTO scan_items(scan_id, title, author, isbn13, danacode, book_id, via, matched, quality, lookup_id, sources)
         VALUES ($1, $2, $3, $4, $5, $6, 'barcode', $7, $8, $9, '{barcode}') RETURNING id`,
        [scan.id, book?.title ?? (r.isbn ? `ISBN ${r.isbn}` : `דאנאקוד ${r.danacode}`), book?.authors?.[0] ?? null, r.isbn, r.danacode ?? null,
          book?.id ?? null, !!book, book ? 'high' : 'low', r.lookupId ?? null],
      )).rows[0];
    });
    await mergeDuplicates(req.user.id);
    const merged = (await one('SELECT decision FROM scan_items WHERE id = $1', [item.id])).decision === 'merged';
    return { item, book, isbn: r.isbn ?? r.danacode, merged, missing: book ? await missingParts(book) : [], ...(await counts(req.user.id)) };
  });
}
