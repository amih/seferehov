import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { config } from './config.js';
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';
import { lookupIsbn, lookupTitle, findOrCreateBook } from './books.js';
import { readBooks, readCover, readIsbnBarcodes, normTitle, sameTitle } from './vision.js';
import { pickFrames } from './frames.js';
import { cropCover } from './covers.js';
import { locationByCode, visibleTo, distanceTo, splitAuthors } from './locations.js';
import { initialStatus, awardSighting } from './moderation.js';
import { parseLatLon, normalizeIsbn, normalizeDanacode } from './util.js';
import { mergeDuplicates, autoConfirmKnown, closeIfDone } from './approvals.js';
import { ownerOf } from './mybooks.js';
import { sendMail } from './mail.js';

// Raw uploads (may carry GPS in EXIF) live outside the public uploads folder and
// are deleted once read. Only re-encoded thumbnails go to uploads/.
const MEDIA_DIR = resolve(process.env.SCAN_DIR || join(config.uploadDir, '..', 'scan-media'));
// Re-encoded copies (no EXIF/GPS) of what was read, kept a while so a better reader
// can go over them again (scripts/rescan.js).
const KEEP_DIR = join(MEDIA_DIR, '..', 'scan-keep');
const KEEP_DAYS = 30;
const MAX_PHOTOS = 8;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

export default async function scanRoutes(app) {
  // Shelf photos (up to 8) or one short video. Processed in the background.
  app.post('/api/locations/:code/scans', {
    preHandler: requireUser(),
    bodyLimit: MAX_VIDEO_BYTES + 1024 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user) || loc.status === 'removed') return reply.code(404).send({ error: 'not_found' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart_required' });

    const id = crypto.randomUUID();
    const dir = join(MEDIA_DIR, id);
    await mkdir(dir, { recursive: true });
    const media = [];
    const fields = {};
    try {
      for await (const part of req.parts({ limits: { files: MAX_PHOTOS + 1, fileSize: MAX_VIDEO_BYTES } })) {
        if (part.type !== 'file') { fields[part.fieldname] = part.value; continue; }
        const ext = (part.filename ?? '').split('.').pop().toLowerCase();
        const isVideo = part.mimetype?.startsWith('video/') || ['mp4', 'mov', 'webm', 'm4v', '3gp'].includes(ext);
        const isImage = part.mimetype?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext);
        if (!isVideo && !isImage) { part.file.resume(); continue; }
        if (isVideo && media.some((m) => m.type === 'video')) { part.file.resume(); continue; }
        const name = `${media.length}.${isVideo ? 'video' : 'img'}`;
        await pipeline(part.file, createWriteStream(join(dir, name)));
        if (part.file.truncated || (!isVideo && part.file.bytesRead > MAX_PHOTO_BYTES)) throw Object.assign(new Error('too_large'), { statusCode: 413 });
        media.push({ path: name, type: isVideo ? 'video' : 'image' });
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      const status = err.statusCode === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400;
      return reply.code(status).send({ error: status === 413 ? 'too_large' : 'bad_upload' });
    }
    if (!media.length) {
      await rm(dir, { recursive: true, force: true });
      return reply.code(400).send({ error: 'no_media' });
    }
    const distance = await distanceTo(loc.id, parseLatLon(fields.lat, fields.lon));
    const kind = fields.kind === 'added' ? 'added' : 'seen';
    const lang = fields.lang === 'en' ? 'en' : 'he';
    await q(
      `INSERT INTO scans(id, location_id, user_id, kind, media, distance_m, lang, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, loc.id, req.user.id, kind, JSON.stringify(media), distance, lang, media.some((m) => m.type === 'video') ? 'video' : 'photo'],
    );
    wake();
    const ahead = (await one(`SELECT count(*)::int AS n FROM scans WHERE status IN ('queued','processing') AND id <> $1`, [id])).n;
    return { scan: { id, status: 'queued', images: media.filter((m) => m.type === 'image').length, video: media.some((m) => m.type === 'video'), ahead } };
  });

  // The front and back covers of one book no catalogue knew (or with no barcode): read in
  // the background, then the book waits in the queue. Without a library code the book
  // is one of the reader's own (My books).
  app.post('/api/covers', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: 'multipart_required' });
    const id = crypto.randomUUID();
    const dir = join(MEDIA_DIR, id);
    await mkdir(dir, { recursive: true });
    const media = [];
    const fields = {};
    try {
      for await (const part of req.parts({ limits: { files: 2, fileSize: MAX_PHOTO_BYTES } })) {
        if (part.type !== 'file') { fields[part.fieldname] = part.value; continue; }
        if (!['photo', 'back'].includes(part.fieldname)) { part.file.resume(); continue; }
        const name = `${part.fieldname === 'photo' ? 0 : 1}.img`;
        await pipeline(part.file, createWriteStream(join(dir, name)));
        if (part.file.truncated) throw Object.assign(new Error('too_large'), { statusCode: 413 });
        media.push({ path: name, type: 'image' });
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      const status = err.statusCode === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400;
      return reply.code(status).send({ error: status === 413 ? 'too_large' : 'bad_upload' });
    }
    let loc = null;
    if (fields.code) {
      loc = await locationByCode(String(fields.code));
      if (!visibleTo(loc, req.user) || loc.status === 'removed') loc = undefined;
    }
    if (!media.some((m) => m.path === '0.img') || loc === undefined) {
      await rm(dir, { recursive: true, force: true });
      return reply.code(loc === undefined ? 404 : 400).send({ error: loc === undefined ? 'not_found' : 'no_media' });
    }
    // Covers of a book whose spine was read at this library but found in no catalogue (by
    // this reader, or by another on an earlier visit): they take the spine's place.
    let replaces = null;
    if (fields.replaces && loc) {
      const r = await one(
        `UPDATE scan_items i SET decision = 'merged', decided_at = now() FROM scans s
          WHERE i.id = $1 AND s.id = i.scan_id AND s.location_id = $2 AND i.book_id IS NULL
            AND (i.decision IS NULL OR i.decision = 'later')
          RETURNING i.id, i.scan_id`,
        [Number(fields.replaces) || 0, loc.id]);
      if (r) { replaces = r.id; await closeIfDone(r.scan_id); }
    }
    const distance = loc ? await distanceTo(loc.id, parseLatLon(fields.lat, fields.lon)) : null;
    const bookCode = normalizeIsbn(fields.isbn) ?? normalizeDanacode(fields.isbn);
    await q(
      `INSERT INTO scans(id, location_id, user_id, kind, media, distance_m, lang, source, book_code, owner, friend_name, replaces_item)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'cover', $8, $9, $10, $11)`,
      [id, loc?.id ?? null, req.user.id, fields.kind === 'added' ? 'added' : 'seen', JSON.stringify(media.sort((a, b) => a.path.localeCompare(b.path))),
        distance, fields.lang === 'en' ? 'en' : 'he', bookCode, ...(loc ? [null, null] : Object.values(ownerOf(fields))), replaces],
    );
    wake();
    return { scan: { id, status: 'queued' } };
  });

  // Finished scans the user has not confirmed yet (for the in-app banner).
  app.get('/api/scans/ready', { preHandler: requireUser() }, async (req) => ({
    scans: await many(
      `SELECT s.id, l.code FROM scans s JOIN locations l ON l.id = s.location_id
        WHERE s.user_id = $1 AND s.status = 'done' AND s.source <> 'cover' AND s.finished_at > now() - interval '3 days'
        ORDER BY s.finished_at DESC LIMIT 5`,
      [req.user.id],
    ),
  }));

  app.get('/api/scans/:id', { preHandler: requireUser() }, async (req, reply) => {
    const scan = await ownScan(req);
    if (!scan) return reply.code(404).send({ error: 'not_found' });
    const items = await many(
      `SELECT i.id, i.title, i.author, i.isbn13, i.via, i.matched, i.frame_path, i.quality, i.crop_path,
              b.id AS book_id, b.title AS book_title, b.authors AS book_authors, b.cover_url, b.year
         FROM scan_items i LEFT JOIN books b ON b.id = i.book_id
        WHERE i.scan_id = $1 ORDER BY i.id`,
      [scan.id],
    );
    for (const i of items) {
      i.frame = i.frame_path && `/uploads/${i.frame_path}`;
      i.crop = i.crop_path && `/uploads/${i.crop_path}`;
      delete i.frame_path; delete i.crop_path;
    }
    // They have seen the result: no "ready" email needed.
    if (['done', 'failed'].includes(scan.status) && !scan.notified_at && scan.user_id === req.user.id) {
      await q('UPDATE scans SET notified_at = now() WHERE id = $1', [scan.id]);
    }
    const ahead = scan.status === 'queued'
      ? (await one(`SELECT count(*)::int AS n FROM scans WHERE status IN ('queued','processing') AND created_at < $1`, [scan.created_at])).n
      : 0;
    return {
      scan: { id: scan.id, code: scan.code, kind: scan.kind, status: scan.status, progress: scan.progress, error: scan.error, ahead, created_at: scan.created_at },
      items,
    };
  });

  // "Not now": drop the results without adding anything.
  app.post('/api/scans/:id/dismiss', { preHandler: requireUser() }, async (req, reply) => {
    const scan = await ownScan(req);
    if (!scan) return reply.code(404).send({ error: 'not_found' });
    await q(`UPDATE scans SET status = 'dismissed' WHERE id = $1 AND status IN ('done','failed')`, [scan.id]);
    return { ok: true };
  });

  // The user ticks the books that really are there; they become sightings.
  app.post('/api/scans/:id/confirm', { preHandler: requireUser() }, async (req, reply) => {
    const scan = await ownScan(req);
    if (!scan) return reply.code(404).send({ error: 'not_found' });
    if (scan.status !== 'done') return reply.code(409).send({ error: 'not_ready' });
    const picks = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const kind = req.body?.kind === 'added' ? 'added' : scan.kind;
    const rows = await many('SELECT * FROM scan_items WHERE scan_id = $1', [scan.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const loc = await one('SELECT id, status FROM locations WHERE id = $1', [scan.location_id]);
    const far = scan.distance_m == null || scan.distance_m > config.maxReportDistanceM;
    const status = loc.status === 'approved' ? initialStatus(req.user, { far }) : 'pending';

    // For the statistics: was each reading/match right? (unticked = dropped)
    const outcome = new Map(rows.map((r) => [r.id, 'dropped']));
    let n = 0;
    for (const p of picks) {
      const item = byId.get(Number(p.id));
      if (!item) continue;
      const title = String(p.title ?? item.title).trim().slice(0, 300);
      const author = String(p.author ?? item.author ?? '').trim().slice(0, 200);
      const edited = title !== item.title || author !== (item.author ?? '');
      outcome.set(item.id, edited ? 'edited' : 'kept');
      const book = item.book_id && !edited
        ? await one('SELECT * FROM books WHERE id = $1', [item.book_id])
        : title && await findOrCreateBook({ title, authors: splitAuthors(author), source: 'llm' });
      if (!book) continue;
      await tx(async (db) => {
        const s = (await db.query(
          `INSERT INTO sightings(book_id, location_id, user_id, kind, status, distance_m)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [book.id, scan.location_id, req.user.id, kind, status, scan.distance_m],
        )).rows[0];
        if (status === 'approved') {
          await awardSighting(db, { userId: req.user.id, locationId: scan.location_id, bookId: book.id, kind, sightingId: s.id });
        }
      });
      n++;
    }
    if (n && status === 'approved') await q('UPDATE locations SET last_checked_at = now() WHERE id = $1', [scan.location_id]);
    await q(`UPDATE scans SET status = 'confirmed' WHERE id = $1`, [scan.id]);
    await q(`UPDATE scan_items i SET outcome = o.v FROM unnest($1::bigint[], $2::text[]) AS o(id, v) WHERE i.id = o.id`,
      [[...outcome.keys()], [...outcome.values()]]);
    return { added: n, status };
  });
}

async function ownScan(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return null;
  const scan = await one(
    `SELECT s.*, l.code FROM scans s JOIN locations l ON l.id = s.location_id WHERE s.id = $1`,
    [req.params.id],
  );
  if (!scan || (scan.user_id !== req.user.id && req.user.trust_level < 2)) return null;
  return scan;
}

// ---------------------------------------------------------------------------
// Worker: one scan at a time (the GPU is the bottleneck).

let busy = false;
let log = console;

export function startScanWorker(logger) {
  log = logger;
  q(`UPDATE scans SET status = 'queued' WHERE status = 'processing'`).then(wake).catch((err) => log.error({ err }, 'scan reset'));
  setInterval(() => { wake(); emailFinished().catch((err) => log.error({ err }, 'scan email')); }, 60_000).unref();
  setInterval(() => purgeKept().catch((err) => log.error({ err }, 'scan keep purge')), 6 * 3600_000).unref();
}

const READY_TEXT = {
  he: {
    done: { subject: 'הספרים מהתמונות שלך מוכנים לאישור', body: (n, url) => `קראנו את התמונות ששלחת ומצאנו ${n} ספרים.\nבדקו ואשרו אותם כאן:\n\n${url}\n\nספרחוב` },
    failed: { subject: 'לא הצלחנו לקרוא את התמונות', body: (_, url) => `לא הצלחנו לקרוא את התמונות ששלחת. אפשר לנסות שוב, מקרוב יותר ובאור טוב:\n\n${url}\n\nספרחוב` },
  },
  en: {
    done: { subject: 'Your shelf photos are ready to check', body: (n, url) => `We read the photos you sent and found ${n} books.\nCheck and confirm them here:\n\n${url}\n\nSeferehov` },
    failed: { subject: 'We could not read your photos', body: (_, url) => `We could not read the photos you sent. You can try again, closer and with good light:\n\n${url}\n\nSeferehov` },
  },
};

// The user may have closed the app while the photos were read: email them when a
// result has waited 2 minutes without being opened and confirmed.
async function emailFinished() {
  const rows = await many(
    `UPDATE scans s SET notified_at = now()
       FROM users u, locations l
      WHERE s.user_id = u.id AND l.id = s.location_id AND s.notified_at IS NULL AND s.source <> 'cover'
        AND s.status IN ('done','confirmed','failed') AND s.finished_at < now() - interval '2 minutes'
        AND s.finished_at > now() - interval '1 day'
      RETURNING s.id, s.status, s.lang, u.email, l.code,
                (SELECT count(*)::int FROM scan_items i WHERE i.scan_id = s.id) AS n`,
  );
  for (const r of rows) {
    const T = READY_TEXT[r.lang === 'en' ? 'en' : 'he'][r.status !== 'failed' && r.n ? 'done' : 'failed'];
    const url = r.status !== 'failed' && r.n ? `${config.baseUrl}/l/${r.code}/check` : `${config.baseUrl}/l/${r.code}/add`;
    await sendMail({ to: r.email, subject: T.subject, text: T.body(r.n, url) }, log);
  }
}

function wake() {
  if (busy) return;
  busy = true;
  drain().catch((err) => log.error({ err }, 'scan worker')).finally(() => { busy = false; });
}

async function drain() {
  for (;;) {
    const scan = await one(
      `UPDATE scans SET status = 'processing', started_at = now()
        WHERE id = (SELECT id FROM scans WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,
    );
    if (!scan) return;
    try {
      await processScan(scan);
      await q(`UPDATE scans SET status = 'done', finished_at = now() WHERE id = $1`, [scan.id]);
      await autoConfirmKnown(scan).catch((err) => log.warn({ err, scan: scan.id }, 'auto confirm'));
      await mergeDuplicates(scan.user_id).catch((err) => log.warn({ err, scan: scan.id }, 'merge duplicates'));
    } catch (err) {
      log.error({ err, scan: scan.id }, 'scan failed');
      await q(`UPDATE scans SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [scan.id, String(err.message).slice(0, 300)]);
    } finally {
      await rm(join(MEDIA_DIR, scan.id), { recursive: true, force: true });
    }
  }
}

async function keepCopy(buffer, scanId, i) {
  await mkdir(join(KEEP_DIR, scanId), { recursive: true });
  await sharp(buffer).rotate().jpeg({ quality: 92 }).toFile(join(KEEP_DIR, scanId, `${i}.jpg`));
}

async function purgeKept() {
  const old = await many(`SELECT id FROM scans WHERE created_at < now() - make_interval(days => $1) AND created_at > now() - make_interval(days => $1 + 7)`, [KEEP_DAYS]);
  for (const { id } of old) await rm(join(KEEP_DIR, id), { recursive: true, force: true });
}

const setProgress = (id, progress) => q('UPDATE scans SET progress = $2 WHERE id = $1', [id, progress]);

async function saveFrameThumb(buffer, scanId, i) {
  const month = new Date().toISOString().slice(0, 7);
  const rel = `${month}/scan-${scanId.slice(0, 8)}-${i}.webp`;
  await mkdir(join(config.uploadDir, month), { recursive: true });
  await sharp(buffer).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 })
    .toFile(join(config.uploadDir, rel)); // re-encoding drops EXIF/GPS
  return rel;
}

// The cut-out spine, so the user can compare it with what we read.
async function saveCropThumb(jpeg, scanId, n) {
  const month = new Date().toISOString().slice(0, 7);
  const rel = `${month}/scan-${scanId.slice(0, 8)}-c${n}.webp`;
  await mkdir(join(config.uploadDir, month), { recursive: true });
  await sharp(jpeg).resize(1200, 300, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(join(config.uploadDir, rel));
  return rel;
}

// One book's covers: read, looked up (the scanned code first, then the barcode or ISBN
// read from the covers, then the title), and one queue item with both pictures.
async function processCover(scan) {
  const dir = join(MEDIA_DIR, scan.id);
  await setProgress(scan.id, { step: 'reading', done: 0, total: 1 });
  let [front, back = null] = await Promise.all(scan.media.map((m) => readFile(join(dir, m.path))));
  // Cut out and straightened first: tidier pictures, and a clearer read.
  front = await cropCover(front).catch(() => null) ?? front;
  if (back) back = await cropCover(back).catch(() => null) ?? back;
  const frame = await saveFrameThumb(front, scan.id, 0);
  const backPath = back && await saveFrameThumb(back, scan.id, 1);
  for (const [i, b] of [front, back].entries()) if (b) await keepCopy(b, scan.id, i).catch((err) => log.warn({ err, scan: scan.id }, 'keep copy failed'));
  const read = await readCover(front, back);
  let book = null, lookupId = null, isbn = null, danacode = null;
  // A Danacode read from print may be misread: its book counts only if its title matches
  // the front cover. Barcodes and ISBNs have check digits and are trusted.
  let doubtful = null;
  for (const code of [scan.book_code, ...(read.codes ?? [])].filter(Boolean)) {
    const r = await lookupIsbn(code, 'scan').catch(() => ({}));
    const trusted = !read.unchecked?.includes(code) || code === scan.book_code || !read.title || !r.book || sameTitle(r.book.title, read.title);
    if (!trusted) { doubtful ??= r; continue; }
    isbn ??= r.isbn ?? null;
    danacode ??= r.danacode ?? null;
    lookupId = r.lookupId ?? lookupId;
    if ((book = r.book ?? null)) break;
  }
  if (!book && !isbn && !danacode && doubtful) ({ isbn = null, danacode = null } = doubtful);
  if (!book && read.title) {
    const r = await lookupTitle(read.title, read.author, 'scan').catch(() => ({}));
    book = r.book ?? null;
    lookupId = r.lookupId ?? lookupId;
  }
  // Nothing readable: the item still waits, with its pictures, for the reader to type the title.
  const title = read.title || book?.title || (isbn ? `ISBN ${isbn}` : danacode ? `דאנאקוד ${danacode}` : '');
  await q(
    `INSERT INTO scan_items(scan_id, title, author, isbn13, danacode, book_id, via, matched, frame_path, back_path, quality, lookup_id, sources)
     VALUES ($1, $2, $3, $4, $5, $6, 'vision', $7, $8, $9, $10, $11, '{cover}')`,
    [scan.id, title, read.author ?? book?.authors?.[0] ?? null, book?.isbn13 ?? isbn, danacode, book?.id ?? null, !!book, frame, backPath,
      book ? 'high' : read.quality === 'low' ? 'low' : 'medium', lookupId],
  );
}

async function processScan(scan) {
  if (scan.source === 'cover') return processCover(scan);
  const dir = join(MEDIA_DIR, scan.id);
  await setProgress(scan.id, { step: 'frames' });
  const images = [];
  for (const m of scan.media) {
    const file = join(dir, m.path);
    if (m.type === 'video') {
      for (const f of await pickFrames(file)) images.push({ buffer: f.buffer, fromVideo: true });
    } else {
      images.push({ buffer: await readFile(file), fromVideo: false });
    }
  }
  if (!images.length) throw new Error('no usable frames');

  // Dedupe across photos/frames. Titles are fuzzy-merged ("SELF AND IDENTITY" ≈
  // "Handbook of Self and Identity"); `frames` counts how many frames showed it.
  const found = [];
  const add = (key, item, i) => {
    const near = (a, b) => a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)));
    const hit = found.find((f) => near(f.key, key));
    if (hit) {
      hit.frames.add(i);
      if ((item.title?.length ?? 0) > (hit.title?.length ?? 0)) hit.title = item.title;
      hit.author ||= item.author;
      hit.isbn ||= item.isbn;
      if (hit.quality === 'low' && item.quality && item.quality !== 'low') hit.quality = item.quality;
      if (!hit.crop && item.crop) Object.assign(hit, { crop: item.crop, verified: item.verified });
      return;
    }
    found.push({ ...item, key, frames: new Set([i]) });
  };
  for (const [i, { buffer: buf, fromVideo }] of images.entries()) {
    await setProgress(scan.id, { step: 'reading', done: i, total: images.length });
    const frame = await saveFrameThumb(buf, scan.id, i);
    await keepCopy(buf, scan.id, i).catch((err) => log.warn({ err, scan: scan.id }, 'keep copy failed'));
    for (const isbn of await readIsbnBarcodes(buf)) add(`isbn:${isbn}`, { isbn, via: 'barcode', frame, fromVideo }, i);
    let books = [];
    try { books = await readBooks(buf); } catch (err) { log.warn({ err, scan: scan.id }, 'vision failed on frame'); }
    for (const b of books) add(normTitle(b.title), { ...b, via: 'vision', frame, fromVideo }, i);
  }

  await setProgress(scan.id, { step: 'matching', done: 0, total: found.length });
  let done = 0;
  const seenBooks = new Set();
  const rows = [];
  for (const item of found) {
    let book = null, lookupId = null;
    const isbn = item.isbn;
    if (isbn) ({ book = null, lookupId = null } = await lookupIsbn(isbn, 'scan').catch(() => ({})));
    if (!book && item.title) {
      const r = await lookupTitle(item.title, item.author, 'scan').catch(() => ({}));
      book = r.book ?? null;
      lookupId = r.lookupId ?? lookupId;
    }
    await setProgress(scan.id, { step: 'matching', done: ++done, total: found.length });
    if (book && seenBooks.has(book.id)) continue; // the barcode and the spine of the same book
    if (book) seenBooks.add(book.id);
    // In a video every spine shows up in several frames; a title read only once
    // and found in no catalogue is most likely a misreading.
    if (!book && item.via === 'vision' && item.fromVideo && item.frames.size < 2) continue;
    // A reading that OCR did not confirm on a cut-out of its own spine (only the whole
    // shelf was read) is often invented: kept only when a catalogue knows the book and
    // the title is long enough not to match some other book by chance.
    if (item.via === 'vision' && item.verified === undefined && (!book || normTitle(item.title).replace(/ /g, '').length < 8)) continue;
    const title = item.title || book?.title || (isbn && `ISBN ${isbn}`);
    const quality = book ? 'high' : item.quality === 'low' ? 'low' : 'medium';
    if (title) rows.push({ item, book, title, isbn, quality, lookupId });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  rows.sort((a, b) => rank[a.quality] - rank[b.quality]); // surest first
  for (const [n, { item, book, title, isbn, quality, lookupId }] of rows.entries()) {
    const crop = item.crop ? await saveCropThumb(item.crop, scan.id, n) : null;
    await q(
      `INSERT INTO scan_items(scan_id, title, author, isbn13, book_id, via, matched, frame_path, quality, crop_path, lookup_id, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [scan.id, title, item.author ?? book?.authors?.[0] ?? null, book?.isbn13 ?? isbn ?? null, book?.id ?? null, item.via, !!book, item.frame, quality, crop, lookupId,
        [item.via === 'barcode' ? 'barcode' : scan.source]],
    );
  }
}
