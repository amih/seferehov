// The reader's own books: scanned at home, away from any library. When one is later
// left in a library, it is reported there as an 'added' sighting.
import { one, many, q } from './db.js';
import { coverTexts } from './seo.js';
import { requireUser } from './auth.js';
import { lookupIsbn, upsertBook, findOrCreateBook } from './books.js';
import { savePhoto, photoUrls } from './photos.js';
import { readForm } from './multipart.js';
import { locationByCode, visibleTo, distanceTo, splitAuthors, recordSighting } from './locations.js';
import { parseLatLon } from './util.js';
import { bookDetails, missingParts } from './details.js';

const LIST_SQL = `
  SELECT m.id, m.created_at, m.placed_at, m.owner, m.friend_name, m.offer, m.price, m.condition, m.offer_note,
         m.offer_place_id, op.name AS offer_place, op.name_he AS offer_place_he, b.id AS book_id, b.isbn13, b.title, b.authors, b.year, b.genre, b.language,
         COALESCE(b.front_url, b.cover_url) AS cover_url, p.path, p.thumb_path,
         l.code, l.name AS location_name, s.status AS sighting_status
    FROM my_books m JOIN books b ON b.id = m.book_id
    LEFT JOIN photos p ON p.id = m.photo_id
    LEFT JOIN locations l ON l.id = m.location_id
    LEFT JOIN sightings s ON s.id = m.sighting_id
    LEFT JOIN places op ON op.id = m.offer_place_id`;
const publicRow = ({ path, thumb_path, ...r }) => ({ ...r, photo: path ? photoUrls({ path, thumb_path }) : null });

// Whose book: the reader's own, a friend's at the friend's home, or borrowed from a friend.
export const ownerOf = (f) => {
  const owner = ['friend', 'borrowed'].includes(f.owner) ? f.owner : 'mine';
  return { owner, friendName: owner === 'mine' ? null : String(f.friend_name ?? '').trim().slice(0, 80) || null };
};

export default async function myBookRoutes(app) {
  app.get('/api/my-books', { preHandler: requireUser() }, async (req) => {
    const rows = (await many(`${LIST_SQL} WHERE m.user_id = $1 ORDER BY m.placed_at DESC NULLS FIRST, m.created_at DESC LIMIT 500`, [req.user.id])).map(publicRow);
    return {
      home: rows.filter((r) => !r.placed_at && r.owner === 'mine'),
      friends: rows.filter((r) => !r.placed_at && r.owner !== 'mine'),
      placed: rows.filter((r) => r.placed_at),
    };
  });

  // By ISBN (a title is needed only when no catalogue knows it), or by title and author.
  app.post('/api/my-books', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 300, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { fields, files } = await readForm(req); // multipart when sent from the offline queue
    let book = null;
    if (fields.isbn) {
      const r = await lookupIsbn(fields.isbn, 'my_books');
      if (r.error) return reply.code(400).send(r);
      book = r.book;
      if (!book && fields.title) book = await upsertBook({ isbn13: r.isbn, danacode: r.danacode, title: String(fields.title).slice(0, 300), authors: splitAuthors(fields.author), source: 'user' });
      if (!book) return reply.code(422).send({ error: 'book_not_found', isbn: r.isbn ?? r.danacode });
    } else if (String(fields.title ?? '').trim()) {
      book = await findOrCreateBook({ title: String(fields.title).trim().slice(0, 300), authors: splitAuthors(fields.author), source: 'user' });
    }
    if (!book) return reply.code(422).send({ error: 'title_required' });
    const had = await one('SELECT id FROM my_books WHERE user_id = $1 AND book_id = $2 AND placed_at IS NULL', [req.user.id, book.id]);
    if (had && !fields.again) return { item: had, book, already: true, missing: await missingParts(book) };
    const photo = files.photo && await savePhoto(files.photo, { userId: req.user.id, kind: 'cover' });
    const back = files.back && await savePhoto(files.back, { userId: req.user.id, kind: 'back' });
    const { owner, friendName } = ownerOf(fields);
    const item = await one('INSERT INTO my_books(user_id, book_id, photo_id, back_photo_id, owner, friend_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.user.id, book.id, photo?.id ?? null, back?.id ?? null, owner, friendName]);
    return { item, book, missing: await missingParts(book) };
  });

  // One of the reader's books, for its own page: large pictures and the back-cover text.
  app.get('/api/my-books/:id', { preHandler: requireUser() }, async (req, reply) => {
    const m = await one(
      `SELECT m.*, p.path AS front_path, p.created_at AS front_at, pb.path AS back_path, pb.created_at AS back_at, l.code, l.name AS location_name
         FROM my_books m LEFT JOIN photos p ON p.id = m.photo_id LEFT JOIN photos pb ON pb.id = m.back_photo_id
         LEFT JOIN locations l ON l.id = m.location_id WHERE m.id = $1 AND m.user_id = $2`,
      [Number(req.params.id), req.user.id],
    );
    if (!m) return reply.code(404).send({ error: 'not_found' });
    let book = await one('SELECT * FROM books WHERE id = $1', [m.book_id]);
    const ready = await Promise.race([bookDetails(book), new Promise((r) => setTimeout(r, 5000, null))]);
    if (ready) book = ready;
    return {
      item: { id: m.id, created_at: m.created_at, placed_at: m.placed_at, code: m.code, location_name: m.location_name, owner: m.owner, friend_name: m.friend_name },
      book: {
        id: book.id, isbn13: book.isbn13, title: book.title, authors: book.authors, year: book.year, publisher: book.publisher,
        cover_url: book.cover_url, front_url: book.front_url, back_url: book.back_url,
        description: book.description, details_source: book.details_source, details_pending: !ready,
      },
      texts: await coverTexts(book.id),
      photos: [m.front_path && { url: `/uploads/${m.front_path}`, kind: 'cover', at: m.front_at },
        m.back_path && { url: `/uploads/${m.back_path}`, kind: 'back', at: m.back_at }].filter(Boolean),
    };
  });

  // Covers photographed later (the book was found, but without pictures).
  app.post('/api/my-books/:id/photos', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 120, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const m = await one('SELECT id FROM my_books WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const { files } = await readForm(req);
    const photo = files.photo && await savePhoto(files.photo, { userId: req.user.id, kind: 'cover' });
    const back = files.back && await savePhoto(files.back, { userId: req.user.id, kind: 'back' });
    await q('UPDATE my_books SET photo_id = COALESCE($2, photo_id), back_photo_id = COALESCE($3, back_photo_id) WHERE id = $1', [m.id, photo?.id ?? null, back?.id ?? null]);
    return { ok: true };
  });

  // "I left it in this library."
  app.post('/api/my-books/:id/place', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 300, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const m = await one('SELECT * FROM my_books WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    if (m.placed_at) return reply.code(409).send({ error: 'already_placed' });
    const loc = await locationByCode(String(req.body?.code ?? ''));
    if (!visibleTo(loc, req.user) || loc.status === 'removed') return reply.code(404).send({ error: 'not_found' });
    const book = await one('SELECT * FROM books WHERE id = $1', [m.book_id]);
    const distance = await distanceTo(loc.id, parseLatLon(req.body?.lat, req.body?.lon));
    const sighting = await recordSighting({ user: req.user, loc, book, kind: 'added', distance, photoId: m.photo_id, backPhotoId: m.back_photo_id });
    await q('UPDATE my_books SET placed_at = now(), location_id = $2, sighting_id = $3 WHERE id = $1', [m.id, loc.id, sighting.id]);
    return { sighting, code: loc.code };
  });

  app.delete('/api/my-books/:id', { preHandler: requireUser() }, async (req) => {
    await q('DELETE FROM my_books WHERE id = $1 AND user_id = $2 AND placed_at IS NULL', [Number(req.params.id), req.user.id]);
    return { ok: true };
  });

  // Libraries to choose from: the nearest ones, then those the reader used lately.
  app.get('/api/my-books/libraries', { preHandler: requireUser() }, async (req) => {
    const pos = parseLatLon(req.query.lat, req.query.lon);
    const near = pos ? await many(
      `SELECT l.code, l.name, ST_Distance(l.geom, ST_MakePoint($1, $2)::geography)::int AS distance_m
         FROM locations l WHERE l.status = 'approved' OR (l.status = 'pending' AND l.created_by = $3)
        ORDER BY l.geom <-> ST_MakePoint($1, $2)::geography LIMIT 8`,
      [pos.lon, pos.lat, req.user.id],
    ) : [];
    const recent = await many(
      `SELECT l.code, l.name, max(s.created_at) AS at FROM sightings s JOIN locations l ON l.id = s.location_id
        WHERE s.user_id = $1 AND l.status IN ('approved', 'pending') GROUP BY l.id ORDER BY at DESC LIMIT 8`,
      [req.user.id],
    );
    return { near, recent: recent.filter((r) => !near.some((n) => n.code === r.code)) };
  });
}
