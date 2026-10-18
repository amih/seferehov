import { config, POINTS } from './config.js';
import { one, many, tx } from './db.js';
import { requireUser } from './auth.js';
import { savePhoto, photoUrls, avatarUrl } from './photos.js';
import { bookDetails } from './details.js';
import { lookupIsbn, upsertBook, findOrCreateBook } from './books.js';
import { readForm } from './multipart.js';
import { initialStatus, locationStatus, award, awardSighting } from './moderation.js';
import { parseLatLon, shortCode } from './util.js';
import { checkPrivate } from './privacy.js';
import { waitingFor } from './finder.js';

const DUPLICATE_RADIUS_M = 25;
export const SIGHTING_KINDS = ['seen', 'added', 'taken', 'gone'];
export const CHECK_STATES = ['ok', 'messy', 'damaged', 'empty', 'missing'];
const MAP_LIMIT = 5000;
const CLUSTER_BELOW_ZOOM = 10;
const CELL_PX = 64; // one bubble per ~64 screen pixels

// Latest approved sighting per book; a book is on the shelf when that is 'seen'.
// Books whose latest report here is "taken" or "gone", in the last 90 days.
const TAKEN_BOOKS_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (s.book_id) b.id, b.title, b.authors, b.year, b.cover_url, s.kind, s.created_at AS taken_at
      FROM sightings s JOIN books b ON b.id = s.book_id
     WHERE s.location_id = $1 AND s.status = 'approved'
     ORDER BY s.book_id, s.created_at DESC) x
   WHERE kind IN ('taken', 'gone') AND taken_at > now() - interval '90 days'
   ORDER BY taken_at DESC LIMIT 30`;

const PRESENT_BOOKS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (s.book_id) s.book_id, s.kind, s.created_at
      FROM sightings s
     WHERE s.location_id = $1 AND s.status = 'approved'
     ORDER BY s.book_id, s.created_at DESC
  )
  SELECT b.id, b.isbn13, b.title, b.authors, b.year, b.cover_url, l.created_at AS last_seen
    FROM latest l JOIN books b ON b.id = l.book_id
   WHERE l.kind IN ('seen', 'added')
   ORDER BY l.created_at DESC`;

async function locationByCode(code) {
  return one(
    `SELECT l.*, ST_Y(l.geom::geometry) AS lat, ST_X(l.geom::geometry) AS lon
       FROM locations l WHERE l.code = $1`,
    [String(code).toUpperCase()],
  );
}

const visibleTo = (loc, user) =>
  loc && (loc.status === 'approved' || (user && (user.id === loc.created_by || user.trust_level >= 2)));

// One report of one book at one library; approved at once for trusted readers on the spot.
export async function recordSighting({ user, loc, book, kind, distance, photoId = null, backPhotoId = null }) {
  const far = distance == null || distance > config.maxReportDistanceM;
  const status = loc.status === 'approved' ? initialStatus(user, { far }) : 'pending';
  return tx(async (db) => {
    const row = (await db.query(
      `INSERT INTO sightings(book_id, location_id, user_id, kind, status, photo_id, back_photo_id, distance_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
      [book.id, loc.id, user.id, kind, status, photoId, backPhotoId, distance],
    )).rows[0];
    if (status === 'approved') {
      await awardSighting(db, { userId: user.id, locationId: loc.id, bookId: book.id, kind, sightingId: row.id });
      await db.query('UPDATE locations SET last_checked_at = now() WHERE id = $1', [loc.id]);
    }
    return row;
  });
}

async function distanceTo(locId, pos) {
  if (!pos) return null;
  const r = await one(
    'SELECT ST_Distance(geom, ST_MakePoint($2, $3)::geography)::int AS d FROM locations WHERE id = $1',
    [locId, pos.lon, pos.lat],
  );
  return r?.d ?? null;
}

export default async function locationRoutes(app) {
  app.get('/api/locations', async (req, reply) => {
    const bbox = String(req.query.bbox ?? '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
      return reply.code(400).send({ error: 'bbox=minLon,minLat,maxLon,maxLat required' });
    }
    const clamp = (n, lim) => Math.min(Math.max(n, -lim), lim);
    const [w, s, e, n] = [clamp(bbox[0], 180), clamp(bbox[1], 90), clamp(bbox[2], 180), clamp(bbox[3], 90)];
    const where = `l.geom::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND (l.status = 'approved' OR (l.status = 'pending' AND l.created_by = $5))`;
    const params = [w, s, e, n, req.user?.id ?? null];

    // Zoomed out: one bubble per grid cell instead of thousands of pins.
    if (Number(req.query.zoom) < CLUSTER_BELOW_ZOOM) {
      const clusters = await many(
        `SELECT count(*)::int AS n, avg(ST_Y(l.geom::geometry)) AS lat, avg(ST_X(l.geom::geometry)) AS lon
           FROM locations l WHERE ${where}
          GROUP BY ST_SnapToGrid(l.geom::geometry, $6)`,
        [...params, Math.max(e - w, 0.01) / (Math.min(Math.max(Number(req.query.px) || 400, 200), 4000) / CELL_PX)],
      );
      return { clusters };
    }
    const rows = await many(
      `SELECT l.code, l.name, l.source, l.status, l.restricted,
              ST_Y(l.geom::geometry) AS lat, ST_X(l.geom::geometry) AS lon,
              (SELECT count(DISTINCT s.book_id) FROM sightings s
                WHERE s.location_id = l.id AND s.status = 'approved')::int AS books
         FROM locations l WHERE ${where}
        LIMIT ${MAP_LIMIT}`,
      params,
    );
    return { locations: rows, truncated: rows.length === MAP_LIMIT };
  });

  app.get('/api/locations/:code', async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user)) return reply.code(404).send({ error: 'not_found' });
    const photo = loc.photo_id && await one('SELECT path, thumb_path FROM photos WHERE id = $1', [loc.photo_id]);
    const books = await many(PRESENT_BOOKS_SQL, [loc.id]);
    const taken = await many(TAKEN_BOOKS_SQL, [loc.id]);
    const waiting = await waitingFor([...books, ...taken].map((b) => b.id), req.user?.id);
    for (const b of [...books, ...taken]) b.waiting = waiting.get(b.id) ?? null;
    const activity = await many(
      `SELECT s.kind, s.created_at, b.title, COALESCE(u.screen_name, 'Reader #' || u.id) AS who, u.avatar_path
         FROM sightings s JOIN books b ON b.id = s.book_id LEFT JOIN users u ON u.id = s.user_id
        WHERE s.location_id = $1 AND s.status = 'approved'
        ORDER BY s.created_at DESC LIMIT 15`,
      [loc.id],
    );
    for (const a of activity) { a.avatar = avatarUrl(a.avatar_path); delete a.avatar_path; }
    const pending = req.user ? (await one(
      `SELECT (SELECT count(*) FROM sightings WHERE location_id = $1 AND user_id = $2 AND status = 'pending')::int AS n,
              (SELECT count(*) FROM location_edits WHERE location_id = $1 AND user_id = $2 AND status = 'pending')::int AS edits`,
      [loc.id, req.user.id],
    )) : { n: 0, edits: 0 };
    const scans = req.user ? await many(
      `SELECT id, status, created_at FROM scans
        WHERE location_id = $1 AND user_id = $2 AND status IN ('queued','processing','done')
          AND created_at > now() - interval '3 days'
        ORDER BY created_at DESC LIMIT 5`,
      [loc.id, req.user.id],
    ) : [];
    return {
      location: {
        code: loc.code, name: loc.name, description: loc.description, lat: loc.lat, lon: loc.lon,
        source: loc.source, status: loc.status, restricted: loc.restricted,
        osm: loc.osm_id ? `https://www.openstreetmap.org/${loc.osm_type}/${loc.osm_id}` : null,
        last_checked_at: loc.last_checked_at, created_at: loc.created_at,
        last_check: await one('SELECT state, created_at AS at FROM location_checks WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1', [loc.id]),
        photo: photoUrls(photo),
        place: loc.place_id ? await one('SELECT id, slug, name, name_he FROM places WHERE id = $1', [loc.place_id]) : null,
      },
      books, taken, activity, my_pending: pending.n, my_pending_edits: pending.edits, my_scans: scans,
    };
  });

  app.post('/api/locations', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { fields, files } = await readForm(req);
    const pos = parseLatLon(fields.lat, fields.lon);
    if (!pos) return reply.code(400).send({ error: 'location_required' });

    if (fields.force !== '1') {
      const dup = await one(
        `SELECT code, name FROM locations
          WHERE status <> 'rejected' AND ST_DWithin(geom, ST_MakePoint($1, $2)::geography, $3)
          ORDER BY geom <-> ST_MakePoint($1, $2)::geography LIMIT 1`,
        [pos.lon, pos.lat, DUPLICATE_RADIUS_M],
      );
      if (dup) return reply.code(409).send({ error: 'nearby_exists', location: dup });
    }

    const name = String(fields.name ?? '').trim().slice(0, 120) || null;
    const description = String(fields.description ?? '').trim().slice(0, 1000) || null;
    // Names and hints are public: no door codes, phone numbers and the like.
    const privacy = await checkPrivate(name, description);
    if (privacy.flagged && fields.confirm_private !== '1') {
      return reply.code(422).send({ error: 'private_info', snippets: privacy.snippets });
    }
    const photo = files.photo && await savePhoto(files.photo, { userId: req.user.id, kind: 'location' });
    const status = privacy.flagged ? 'pending' : locationStatus(req.user);
    const restricted = fields.restricted === '1' || fields.restricted === true;

    const loc = await tx(async (db) => {
      let row;
      for (let attempt = 0; !row; attempt++) {
        try {
          row = (await db.query(
            `INSERT INTO locations(code, name, description, geom, status, restricted, photo_id, created_by, last_checked_at, privacy_flag)
             VALUES ($1, $2, $3, ST_MakePoint($4, $5)::geography, $6, $7, $8, $9, now(), $10)
             RETURNING id, code, status`,
            [shortCode(), name, description, pos.lon, pos.lat, status, restricted, photo?.id ?? null, req.user.id,
             privacy.flagged ? { reason: privacy.reason, snippets: privacy.snippets } : null],
          )).rows[0];
        } catch (err) {
          if (err.code !== '23505' || attempt > 5) throw err; // code collision → retry
        }
      }
      if (status === 'approved') {
        await award(db, { userId: req.user.id, points: POINTS.location, reason: 'new_location', refType: 'location', refId: row.id });
      }
      return row;
    });
    return { location: { code: loc.code, status: loc.status } };
  });

  // "I was here": the library is in good shape, messy, damaged, empty, or gone (the
  // last one also goes through the usual removal edit). Keeps the map fresh.
  app.post('/api/locations/:code/check', { preHandler: requireUser() }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user)) return reply.code(404).send({ error: 'not_found' });
    const distance = await distanceTo(loc.id, parseLatLon(req.body?.lat, req.body?.lon));
    if (distance == null || distance > config.maxReportDistanceM) {
      return reply.code(422).send({ error: 'too_far', distance });
    }
    const state = CHECK_STATES.includes(req.body?.state) ? req.body.state : 'ok';
    await tx(async (db) => {
      await db.query('UPDATE locations SET last_checked_at = now() WHERE id = $1', [loc.id]);
      await db.query('INSERT INTO location_checks(location_id, user_id, state) VALUES ($1, $2, $3)', [loc.id, req.user.id, state]);
      const already = (await db.query(
        `SELECT 1 FROM karma_events WHERE user_id = $1 AND reason = 'check' AND ref_id = $2
            AND created_at > now() - interval '1 day'`,
        [req.user.id, loc.id],
      )).rowCount;
      if (!already) await award(db, { userId: req.user.id, points: POINTS.check, reason: 'check', refType: 'location', refId: loc.id });
    });
    return { ok: true };
  });

  // One book at one library: every picture of it taken there, the large covers and
  // the back-cover text found online, and whether it is still on the shelf.
  app.get('/api/locations/:code/books/:id', async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user)) return reply.code(404).send({ error: 'not_found' });
    let book = await one('SELECT * FROM books WHERE id = $1', [Number(req.params.id)]);
    if (!book) return reply.code(404).send({ error: 'not_found' });
    // The first lookup can take a while (the National Library is slow): answer with what
    // we have after a few seconds; the page asks again when told the lookup is still going.
    const details = bookDetails(book);
    const ready = await Promise.race([details, new Promise((r) => setTimeout(r, 5000, null))]);
    const pending = !ready;
    if (ready) book = ready;
    const shelf = await many(
      `SELECT * FROM (
         SELECT p.path AS url, 'cover' AS kind, s.created_at FROM sightings s JOIN photos p ON p.id = s.photo_id
          WHERE s.location_id = $1 AND s.book_id = $2 AND s.status = 'approved'
         UNION ALL
         SELECT p.path, 'back', s.created_at FROM sightings s JOIN photos p ON p.id = s.back_photo_id
          WHERE s.location_id = $1 AND s.book_id = $2 AND s.status = 'approved'
         UNION ALL
         SELECT i.crop_path, 'spine', s.created_at FROM scan_items i JOIN sightings s ON s.id = i.sighting_id
          WHERE s.location_id = $1 AND s.book_id = $2 AND s.status = 'approved' AND i.crop_path IS NOT NULL
         UNION ALL
         SELECT i.frame_path, 'shelf', s.created_at FROM scan_items i JOIN sightings s ON s.id = i.sighting_id
          WHERE s.location_id = $1 AND s.book_id = $2 AND s.status = 'approved' AND i.frame_path IS NOT NULL) x
        ORDER BY created_at DESC LIMIT 12`,
      [loc.id, book.id],
    );
    const latest = await one(
      `SELECT kind, created_at FROM sightings WHERE location_id = $1 AND book_id = $2 AND status = 'approved'
        ORDER BY created_at DESC LIMIT 1`,
      [loc.id, book.id],
    );
    const seen = new Set();
    return {
      location: { code: loc.code, name: loc.name, lat: loc.lat, lon: loc.lon },
      book: {
        id: book.id, isbn13: book.isbn13, title: book.title, authors: book.authors, year: book.year, publisher: book.publisher,
        cover_url: book.cover_url, front_url: book.front_url, back_url: book.back_url,
        description: book.description, details_source: book.details_source, details_pending: pending,
      },
      photos: shelf.filter((p) => !seen.has(p.url) && seen.add(p.url)).map((p) => ({ url: `/uploads/${p.url}`, kind: p.kind, at: p.created_at })),
      here: latest ? { present: ['seen', 'added'].includes(latest.kind), kind: latest.kind, at: latest.created_at } : null,
      waiting: (await waitingFor([book.id], req.user?.id)).get(book.id) ?? null,
    };
  });

  // A cover photographed at the shelf later (the book was there without one): reported
  // as seen, with the picture.
  app.post('/api/locations/:code/books/:id/photos', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user) || loc.status === 'removed') return reply.code(404).send({ error: 'not_found' });
    const book = await one('SELECT * FROM books WHERE id = $1', [Number(req.params.id)]);
    if (!book) return reply.code(404).send({ error: 'not_found' });
    const { fields, files } = await readForm(req);
    if (!files.photo && !files.back) return reply.code(400).send({ error: 'no_media' });
    const photo = files.photo && await savePhoto(files.photo, { userId: req.user.id, kind: 'cover' });
    const back = files.back && await savePhoto(files.back, { userId: req.user.id, kind: 'back' });
    const distance = await distanceTo(loc.id, parseLatLon(fields.lat, fields.lon));
    const s = await recordSighting({ user: req.user, loc, book, kind: 'seen', distance, photoId: photo?.id, backPhotoId: back?.id });
    return { sighting: s };
  });

  app.get('/api/books/lookup', async (req, reply) => {
    const { lookupId, ...result } = await lookupIsbn(req.query.isbn);
    if (result.error) return reply.code(400).send(result);
    return result;
  });

  // Report a book at a location: seen (on the shelf), added (I left it here),
  // taken (I took it), gone (not there any more).
  app.post('/api/locations/:code/sightings', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 200, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const loc = await locationByCode(req.params.code);
    if (!visibleTo(loc, req.user)) return reply.code(404).send({ error: 'not_found' });
    const { fields, files } = await readForm(req);
    const kind = SIGHTING_KINDS.includes(fields.kind) ? fields.kind : 'seen';

    let book = null;
    if (fields.book_id) {
      book = await one('SELECT * FROM books WHERE id = $1', [Number(fields.book_id)]);
    } else if (fields.isbn) {
      const r = await lookupIsbn(fields.isbn, 'sighting');
      if (r.error) return reply.code(400).send(r);
      book = r.book;
      if (!book && fields.title) {
        book = await upsertBook({ isbn13: r.isbn, danacode: r.danacode, title: String(fields.title).slice(0, 300), authors: splitAuthors(fields.author), source: 'user' });
      }
    } else if (fields.title) {
      book = await findOrCreateBook({ title: String(fields.title).slice(0, 300), authors: splitAuthors(fields.author), source: 'user' });
    }
    if (!book) return reply.code(422).send({ error: 'book_not_found' });

    const distance = await distanceTo(loc.id, parseLatLon(fields.lat, fields.lon));
    const photo = files.photo && await savePhoto(files.photo, { userId: req.user.id, kind: 'cover' });
    const back = files.back && await savePhoto(files.back, { userId: req.user.id, kind: 'back' });
    const s = await recordSighting({ user: req.user, loc, book, kind, distance, photoId: photo?.id, backPhotoId: back?.id });
    return { sighting: s, book };
  });

  app.get('/api/leaderboard', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
    const rows = await many(
      `SELECT u.id, u.screen_name IS NOT NULL AS public, COALESCE(u.screen_name, 'Reader #' || u.id) AS name, u.avatar_path, sum(k.points)::int AS points,
              (SELECT sum(points) FROM karma_events WHERE user_id = u.id)::int AS karma
         FROM karma_events k JOIN users u ON u.id = k.user_id
        WHERE k.created_at > now() - make_interval(days => $1)
        GROUP BY u.id ORDER BY points DESC LIMIT 20`,
      [days],
    );
    for (const r of rows) { r.avatar = avatarUrl(r.avatar_path); delete r.avatar_path; }
    return { days, leaders: rows };
  });

  app.get('/api/stats', async () => one(
    `SELECT (SELECT count(*) FROM locations WHERE status = 'approved')::int AS locations,
            (SELECT count(*) FROM books)::int AS books,
            (SELECT count(*) FROM sightings WHERE status = 'approved')::int AS sightings`,
  ));
}

export const splitAuthors = (s) => String(s ?? '').split(/[,;&]/).map((a) => a.trim()).filter(Boolean).slice(0, 10);

export { locationByCode, visibleTo, distanceTo, PRESENT_BOOKS_SQL, TAKEN_BOOKS_SQL };
