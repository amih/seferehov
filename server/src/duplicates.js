// The same book entered twice (a catalogue record and one typed by a reader, two
// spellings, title and author in each other's fields): shown in pairs to trusted
// readers, who keep the better record, fix swapped fields, or mark the pair different.
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';

// same = same title and author; swapped = title and author in each other's fields;
// similar = close spelling of both.
export const PAIRS_SQL = `
  WITH bk AS (
    SELECT id, search_norm(title) AS t, search_norm(COALESCE(authors[1], '')) AS a, isbn13 FROM books)
  SELECT x.id AS a, y.id AS b,
         CASE WHEN x.t = y.t THEN 'same' WHEN x.t = y.a AND x.a = y.t THEN 'swapped' ELSE 'similar' END AS why
    FROM bk x JOIN bk y ON x.id < y.id
   WHERE NOT EXISTS (SELECT 1 FROM book_not_dupes n WHERE n.a = x.id AND n.b = y.id)
     AND ((x.t = y.t AND (x.a = y.a OR x.a = '' OR y.a = ''))
       OR (x.a <> '' AND x.t = y.a AND x.a = y.t)
       OR (similarity(x.t, y.t) > 0.6 AND (x.a = y.a OR similarity(x.a, y.a) > 0.5)))
   ORDER BY x.id DESC LIMIT 30`;

const BOOK_SQL = `
  SELECT b.id, b.title, b.authors, b.isbn13, b.danacode, b.year, b.publisher, b.source,
         COALESCE(b.front_url, b.cover_url) AS cover_url, b.description IS NOT NULL AS has_blurb,
         (SELECT count(*)::int FROM sightings s WHERE s.book_id = b.id) AS sightings,
         (SELECT count(*)::int FROM my_books m WHERE m.book_id = b.id) AS mine
    FROM books b WHERE b.id = ANY($1)`;

// Moves everything of `drop` onto `keep`, fills what keep lacks, and deletes drop.
export async function mergeBooks(keepId, dropId) {
  await tx(async (db) => {
    const [keep, drop] = await Promise.all([keepId, dropId].map(async (id) => (await db.query('SELECT * FROM books WHERE id = $1 FOR UPDATE', [id])).rows[0]));
    if (!keep || !drop) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    for (const t of ['sightings', 'scan_items', 'lookups', 'my_books']) await db.query(`UPDATE ${t} SET book_id = $1 WHERE book_id = $2`, [keepId, dropId]);
    await db.query('DELETE FROM book_watches w WHERE book_id = $2 AND EXISTS (SELECT 1 FROM book_watches k WHERE k.user_id = w.user_id AND k.book_id = $1)', [keepId, dropId]);
    await db.query('UPDATE book_watches SET book_id = $1 WHERE book_id = $2', [keepId, dropId]);
    await db.query('UPDATE books SET isbn13 = NULL, danacode = NULL WHERE id = $1', [dropId]);
    await db.query(
      `UPDATE books SET isbn13 = COALESCE(isbn13, $2), danacode = COALESCE(danacode, $3), cover_url = COALESCE(cover_url, $4),
              front_url = COALESCE(front_url, $5), back_url = COALESCE(back_url, $6), description = COALESCE(description, $7),
              publisher = COALESCE(publisher, $8), year = COALESCE(year, $9),
              authors = CASE WHEN cardinality(authors) = 0 THEN $10 ELSE authors END
        WHERE id = $1`,
      [keepId, drop.isbn13, drop.danacode, drop.cover_url, drop.front_url, drop.back_url, drop.description, drop.publisher, drop.year, drop.authors],
    );
    await db.query('DELETE FROM books WHERE id = $1', [dropId]);
  });
}

export default async function duplicateRoutes(app) {
  const trusted = { preHandler: requireUser(2) };

  app.get('/api/duplicates', trusted, async () => {
    const pairs = await many(PAIRS_SQL);
    const books = new Map((await many(BOOK_SQL, [[...new Set(pairs.flatMap((p) => [p.a, p.b]))]])).map((b) => [b.id, b]));
    return { pairs: pairs.map((p) => ({ why: p.why, a: books.get(p.a), b: books.get(p.b) })).filter((p) => p.a && p.b) };
  });

  // { keep, drop }: one record stays. { a, b, different: true }: not the same book.
  app.post('/api/duplicates', trusted, async (req, reply) => {
    const { keep, drop, a, b, different } = req.body ?? {};
    if (different) {
      const [x, y] = [Number(a), Number(b)].sort((m, n) => m - n);
      await q('INSERT INTO book_not_dupes(a, b, by_user) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [x, y, req.user.id]);
      return { ok: true };
    }
    if (!Number(keep) || !Number(drop) || Number(keep) === Number(drop)) return reply.code(400).send({ error: 'bad_request' });
    await mergeBooks(Number(keep), Number(drop));
    return { ok: true };
  });

  // Title and author were entered in each other's fields.
  app.post('/api/books/:id/swap', trusted, async (req, reply) => {
    const b = await one('SELECT id, title, authors FROM books WHERE id = $1', [Number(req.params.id)]);
    if (!b?.authors?.length) return reply.code(404).send({ error: 'not_found' });
    return one('UPDATE books SET title = $2, authors = $3 WHERE id = $1 RETURNING id, title, authors',
      [b.id, b.authors[0], [b.title, ...b.authors.slice(1)]]);
  });
}
