// The reader's approval queue: books read from their photos and videos, and barcodes
// they scanned, wait here one by one until approved, declined or set aside for later.
import { config } from './config.js';
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';
import { lookupIsbn, findOrCreateBook, withCode } from './books.js';
import { missingParts } from './details.js';
import { locationByCode, visibleTo, distanceTo, splitAuthors, PRESENT_BOOKS_SQL } from './locations.js';
import { initialStatus, awardSighting, award } from './moderation.js';
import { POINTS } from './config.js';
import { PAIRS_SQL, LOCATION_PAIRS_SQL } from './duplicates.js';
import { parseLatLon } from './util.js';
import { readForm } from './multipart.js';
import { normTitle } from './vision.js';
import { fixesToVote } from './fixes.js';

const UNDO_DAYS = 14;

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
    const mine = await one('INSERT INTO my_books(user_id, book_id, photo_id, back_photo_id, owner, friend_name) VALUES ($1, $2, $3, $4, COALESCE($5, \'mine\'), $6) RETURNING id',
      [user.id, book.id, photoId, backPhotoId, scan.owner, scan.friend_name]);
    return { sighting: null, myBookId: mine.id, book, edited };
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
      if (scan.replaces_item) await awardSpine(db, scan, user.id, s.id);
      await db.query('UPDATE locations SET last_checked_at = now() WHERE id = $1', [scan.location_id]);
    }
    return s;
  });
  return { sighting, book, edited };
}

// Covers for a spine found in no catalogue: the reader who found the spine gets points
// whoever took the covers, and a reader who took them for someone else's spine gets more.
async function awardSpine(db, scan, userId, sightingId) {
  const finder = (await db.query(
    'SELECT s.user_id FROM scan_items i JOIN scans s ON s.id = i.scan_id WHERE i.id = $1', [scan.replaces_item])).rows[0]?.user_id;
  if (!finder) return;
  await award(db, { userId: finder, points: POINTS.spine, reason: 'spine', refType: 'sighting', refId: sightingId });
  if (finder !== userId) await award(db, { userId, points: POINTS.spineCovers, reason: 'spine_covers', refType: 'sighting', refId: sightingId });
}

// Spines read at a library that no catalogue knew and nobody has photographed the
// covers of yet: shown on the library page, for whoever comes by next.
export const OPEN_SPINES_SQL = `
  SELECT i.id, i.title, i.author, i.crop_path, i.frame_path, i.created_at, s.user_id
    FROM scan_items i JOIN scans s ON s.id = i.scan_id
   WHERE s.location_id = $1 AND s.source IN ('photo', 'video') AND s.status IN ('done', 'confirmed')
     AND i.book_id IS NULL AND i.quality <> 'low' AND (i.decision IS NULL OR i.decision = 'later')
     AND i.crop_path IS NOT NULL AND i.created_at > now() - interval '60 days'
   ORDER BY i.created_at DESC LIMIT 12`;

// A scan is finished once none of its books waits for a decision.
export async function closeIfDone(scanId) {
  await q(
    `UPDATE scans SET status = 'confirmed' WHERE id = $1 AND status = 'done'
       AND NOT EXISTS (SELECT 1 FROM scan_items WHERE scan_id = $1 AND (decision IS NULL OR decision = 'later'))`,
    [scanId],
  );
}

// Shelf photos at a library: a book the photos found that is already on that library's
// shelf needs no approval: it is marked seen now (unless this reader reported it seen in
// the last few hours). Returns how many were confirmed.
export async function autoConfirmKnown(scan) {
  if (!scan.location_id || scan.kind !== 'seen' || !['photo', 'video'].includes(scan.source)) return 0;
  const items = await many(
    `SELECT i.* FROM scan_items i
      WHERE i.scan_id = $2 AND i.decision IS NULL AND i.book_id IN (SELECT id FROM (${PRESENT_BOOKS_SQL}) p)`,
    [scan.location_id, scan.id],
  );
  if (!items.length) return 0;
  const user = await one('SELECT * FROM users WHERE id = $1', [scan.user_id]);
  for (const item of items) {
    const recent = await one(
      `SELECT id FROM sightings WHERE user_id = $1 AND location_id = $2 AND book_id = $3 AND kind = 'seen'
          AND created_at > now() - interval '3 hours' LIMIT 1`,
      [user.id, scan.location_id, item.book_id],
    );
    const sighting = recent ? null : (await approveItem(item, scan, user))?.sighting;
    await q(`UPDATE scan_items SET decision = 'approved', decided_at = now(), outcome = 'kept', auto = true, sighting_id = $2 WHERE id = $1`,
      [item.id, sighting?.id ?? recent?.id ?? null]);
  }
  await closeIfDone(scan.id);
  return items.length;
}

// What a reader's shelf photos at one library said, over the last few hours (several
// uploads are one visit): books confirmed as still there, spines no catalogue knew
// (worth taking out for cover photos), and, once the photos are enough to judge, the
// books listed here that none of them showed.
const SESSION_HOURS = 3;
const ENOUGH_PHOTOS = 3;
export async function shelfCheck(user, loc) {
  const scans = await many(
    `SELECT id, status, media, created_at FROM scans
      WHERE user_id = $1 AND location_id = $2 AND source IN ('photo', 'video')
        AND created_at > now() - make_interval(hours => $3) ORDER BY created_at`,
    [user.id, loc.id, SESSION_HOURS],
  );
  if (!scans.length) return { scans: 0 };
  const ids = scans.map((x) => x.id);
  const processing = scans.filter((x) => ['queued', 'processing'].includes(x.status)).length;
  const media = scans.flatMap((x) => (typeof x.media === 'string' ? JSON.parse(x.media) : x.media) ?? []);
  const photos = media.filter((m) => m.type === 'image').length;
  const enough = media.some((m) => m.type === 'video') || photos >= ENOUGH_PHOTOS;
  const items = await many(
    `SELECT i.id, i.title, i.author, i.crop_path, i.frame_path, i.book_id, i.decision, i.auto, b.title AS book_title, b.cover_url
       FROM scan_items i LEFT JOIN books b ON b.id = i.book_id
      WHERE i.scan_id = ANY($1::uuid[]) ORDER BY i.id`,
    [ids],
  );
  const pic = (p) => p && `/uploads/${p}`;
  const confirmed = items.filter((i) => i.auto).map((i) => ({ id: i.book_id, title: i.book_title, cover_url: i.cover_url }));
  const fresh = items.filter((i) => !i.book_id && (i.decision == null || i.decision === 'later'))
    .map((i) => ({ id: i.id, title: i.title, author: i.author, crop: pic(i.crop_path), frame: pic(i.frame_path) }));
  let missing = [];
  if (enough && !processing) {
    const shown = new Set(items.map((i) => i.book_id).filter(Boolean));
    // Answered since the visit began (still here / gone): not asked again.
    const answered = new Set((await many(
      `SELECT DISTINCT book_id FROM sightings WHERE user_id = $1 AND location_id = $2 AND created_at >= $3`,
      [user.id, loc.id, scans[0].created_at])).map((r) => r.book_id));
    missing = (await many(PRESENT_BOOKS_SQL, [loc.id])).filter((b) => !shown.has(b.id) && !answered.has(b.id))
      .map((b) => ({ id: b.id, title: b.title, authors: b.authors, cover_url: b.cover_url, last_seen: b.last_seen }));
  }
  return { scans: scans.length, processing, photos, enough, enoughPhotos: ENOUGH_PHOTOS, confirmed, fresh, missing };
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

// Pairs of books that may be the same: slow to find, so counted at most every 10 minutes.
let dupes = { at: 0, n: 0 };
async function duplicateCount() {
  if (dupes.at < Date.now() - 600_000) dupes = { at: Date.now(), n: (await many(PAIRS_SQL)).length };
  return dupes.n;
}

export default async function approvalRoutes(app) {
  app.get('/api/queue/count', { preHandler: requireUser() }, async (req) => counts(req.user.id));

  // Everything waiting for this reader, by list (only the lists they may work on).
  app.get('/api/todo', { preHandler: requireUser() }, async (req) => {
    const c = await counts(req.user.id);
    const r = { mine: c.open + c.later, processing: c.processing };
    if (req.user.trust_level >= 1) r.fixes = await fixesToVote(req.user);
    if (req.user.trust_level >= 2) {
      r.review = (await one(
        `SELECT (SELECT count(*) FROM locations WHERE status = 'pending')
              + (SELECT count(*) FROM sightings s JOIN locations l ON l.id = s.location_id WHERE s.status = 'pending' AND l.status = 'approved')
              + (SELECT count(*) FROM location_edits WHERE status = 'pending') AS n`)).n * 1;
      r.duplicates = await duplicateCount();
      r.libraries = (await many(LOCATION_PAIRS_SQL)).length;
    }
    if (req.user.trust_level >= 3) r.texts = (await one(`SELECT count(*)::int AS n FROM photos WHERE ocr_status = 'review'`)).n;
    return r;
  });

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
      `UPDATE scan_items SET decision = $2, decided_at = now(), outcome = $3, sighting_id = $4, my_book_id = $5 WHERE id = $1`,
      [item.id, decision, outcome, result?.sighting?.id ?? null, result?.myBookId ?? null],
    );
    await closeIfDone(item.scan_id);
    return { status: result?.sighting?.status ?? null, ...(await counts(req.user.id)) };
  });

  // The reader's last decisions, newest first: a wrong tap can be undone, a title fixed.
  app.get('/api/queue/recent', { preHandler: requireUser() }, async (req) => {
    const items = await many(
      `SELECT i.id, i.decision, i.decided_at, i.crop_path, i.frame_path, i.title AS read_title,
              COALESCE(sb.title, mb.title, i.title) AS title, COALESCE(sb.authors, mb.authors) AS authors,
              l.code, l.name AS location_name, m.placed_at
         FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN locations l ON l.id = s.location_id
         LEFT JOIN sightings si ON si.id = i.sighting_id LEFT JOIN books sb ON sb.id = si.book_id
         LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books mb ON mb.id = m.book_id
        WHERE s.user_id = $1 AND i.decision IN ('approved', 'declined') AND i.decided_at > now() - interval '${UNDO_DAYS} days'
        ORDER BY i.decided_at DESC, i.id DESC LIMIT 50`,
      [req.user.id],
    );
    return {
      items: items.map(({ crop_path, frame_path, placed_at, ...i }) => ({
        ...i, pic: (crop_path || frame_path) && `/uploads/${crop_path || frame_path}`, undoable: !placed_at,
      })),
    };
  });

  // Undo: the sighting (and its points) or the My books entry goes, and the book waits
  // in the queue again, to be approved (perhaps with a fixed title) or declined.
  app.post('/api/queue/:id/undo', { preHandler: requireUser() }, async (req, reply) => {
    const item = await one(
      `SELECT i.*, m.placed_at FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN my_books m ON m.id = i.my_book_id
        WHERE i.id = $1 AND s.user_id = $2 AND i.decision IN ('approved', 'declined')
          AND i.decided_at > now() - interval '${UNDO_DAYS} days'`,
      [Number(req.params.id), req.user.id],
    );
    if (!item) return reply.code(404).send({ error: 'not_found' });
    if (item.placed_at) return reply.code(409).send({ error: 'already_placed' });
    await tx(async (db) => {
      if (item.sighting_id) {
        const si = (await db.query('DELETE FROM sightings WHERE id = $1 RETURNING photo_id, back_photo_id', [item.sighting_id])).rows[0];
        await db.query(`DELETE FROM karma_events WHERE ref_type = 'sighting' AND ref_id = $1`, [item.sighting_id]);
        if (si) await db.query('DELETE FROM photos WHERE id = ANY($1)', [[si.photo_id, si.back_photo_id].filter(Boolean)]);
      }
      if (item.my_book_id) {
        const m = (await db.query('DELETE FROM my_books WHERE id = $1 RETURNING photo_id, back_photo_id', [item.my_book_id])).rows[0];
        if (m) await db.query('DELETE FROM photos WHERE id = ANY($1)', [[m.photo_id, m.back_photo_id].filter(Boolean)]);
      }
      await db.query(
        `UPDATE scan_items SET decision = NULL, decided_at = NULL, outcome = NULL, sighting_id = NULL, my_book_id = NULL WHERE id = $1`, [item.id]);
      await db.query(`UPDATE scans SET status = 'done' WHERE id = $1 AND status = 'confirmed'`, [item.scan_id]);
    });
    const back = await one(`${ITEM_SQL} WHERE i.id = $1`, [item.id]);
    return { item: publicItem(back), ...(await counts(req.user.id)) };
  });

  app.get('/api/locations/:code/shelf-check', { preHandler: requireUser() }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user)) return reply.code(404).send({ error: 'not_found' });
    return shelfCheck(req.user, loc);
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
