// Readers on books: "I read it" (one tap), then stars, then a review in their own words,
// helped by a few questions. Public under the reader's screen name, on the book's page
// and on the reader's page (/r/<id>), which lists the books they read and recommend.
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { patternCheck } from './privacy.js';
import { avatarUrl } from './photos.js';
import { normTitle } from './vision.js';
import { forgetPages } from './seo.js';

export const QUESTIONS = ['summary', 'liked', 'recommend_to', 'when'];
const MAX = { summary: 300, liked: 3000, recommend_to: 600, when: 200 };

// Public reviews of one book, newest first; written ones before bare "I read it"s.
export const BOOK_REVIEWS_SQL = `
  SELECT r.id, r.rating, r.answers, r.created_at, r.updated_at, u.id AS user_id, u.screen_name, u.avatar_path
    FROM book_reviews r JOIN users u ON u.id = r.user_id
   WHERE r.book_id = $1 AND NOT r.hidden AND u.screen_name IS NOT NULL
   ORDER BY (r.answers <> '{}'::jsonb) DESC, r.updated_at DESC LIMIT 100`;

export const READER_REVIEWS_SQL = `
  SELECT r.rating, r.answers, r.updated_at, b.id AS book_id, b.title, b.authors, COALESCE(b.front_url, b.cover_url) AS cover_url
    FROM book_reviews r JOIN books b ON b.id = r.book_id
   WHERE r.user_id = $1 AND NOT r.hidden
   ORDER BY (r.rating >= 4) DESC NULLS LAST, r.updated_at DESC LIMIT 500`;

export const hasText = (answers) => QUESTIONS.some((k) => answers?.[k]);
export const publicReview = ({ avatar_path, ...r }) => ({ ...r, avatar: avatarUrl(avatar_path) });

// Words copied from the blurb or the back cover are not a review: share of the review's
// 6-word runs that also appear in those texts.
function copiedShare(text, sources) {
  const grams = (s) => {
    const w = normTitle(s).split(' ').filter(Boolean);
    return w.length < 6 ? [] : w.slice(0, -5).map((_, i) => w.slice(i, i + 6).join(' '));
  };
  const mine = grams(text);
  if (mine.length < 3) return 0;
  const theirs = new Set(sources.flatMap(grams));
  return mine.filter((g) => theirs.has(g)).length / mine.length;
}

export default async function reviewRoutes(app) {
  app.get('/api/books/:id/reviews', async (req) => {
    const id = Number(req.params.id);
    const rows = (await many(BOOK_REVIEWS_SQL, [id])).map(publicReview);
    const mine = req.user ? await one('SELECT rating, answers, hidden FROM book_reviews WHERE user_id = $1 AND book_id = $2', [req.user.id, id]) : null;
    const rated = rows.filter((r) => r.rating);
    return {
      reviews: rows,
      mine,
      readers: rows.length,
      average: rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : null,
    };
  });

  // Upsert: { read: true } alone, or with rating and/or answers. { read: false } deletes.
  app.put('/api/books/:id/review', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 200, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const id = Number(req.params.id);
    const book = await one('SELECT id, description FROM books WHERE id = $1', [id]);
    if (!book) return reply.code(404).send({ error: 'not_found' });
    if (!req.user.screen_name) return reply.code(422).send({ error: 'screen_name_required' });
    const { read = true, rating, answers } = req.body ?? {};
    if (!read) {
      await q('DELETE FROM book_reviews WHERE user_id = $1 AND book_id = $2', [req.user.id, id]);
      forgetPages(`/b/${id}`); forgetPages(`/r/${req.user.id}`);
      return { mine: null };
    }
    const r = rating == null ? null : Number(rating);
    if (r != null && !(Number.isInteger(r) && r >= 1 && r <= 5)) return reply.code(400).send({ error: 'bad_rating' });
    let clean = null;
    if (answers && typeof answers === 'object') {
      clean = {};
      for (const k of QUESTIONS) {
        const v = String(answers[k] ?? '').trim().slice(0, MAX[k]);
        if (v) clean[k] = v;
      }
      const all = Object.values(clean).join('\n');
      const snippets = patternCheck(all);
      if (snippets.length) return reply.code(422).send({ error: 'private_info', snippets });
      const covers = await many(
        `SELECT p.ocr_text FROM photos p WHERE p.ocr_text IS NOT NULL AND p.id IN (
           SELECT unnest(ARRAY[s.photo_id, s.back_photo_id]) FROM sightings s WHERE s.book_id = $1
           UNION SELECT unnest(ARRAY[m.photo_id, m.back_photo_id]) FROM my_books m WHERE m.book_id = $1)`, [id]);
      if (copiedShare(all, [book.description ?? '', ...covers.map((c) => c.ocr_text)]) > 0.4) return reply.code(422).send({ error: 'copied' });
    }
    const mine = await one(
      `INSERT INTO book_reviews(user_id, book_id, rating, answers) VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         rating = CASE WHEN $5 THEN EXCLUDED.rating ELSE book_reviews.rating END,
         answers = COALESCE($4::jsonb, book_reviews.answers), updated_at = now()
       RETURNING rating, answers, hidden`,
      [req.user.id, id, r, clean ? JSON.stringify(clean) : null, rating !== undefined]);
    forgetPages(`/b/${id}`); forgetPages(`/r/${req.user.id}`);
    return { mine };
  });

  // A reader's public page: screen name, picture, and the books they read.
  app.get('/api/readers/:id', async (req, reply) => {
    const u = await one('SELECT id, screen_name, avatar_path, created_at FROM users WHERE id = $1 AND screen_name IS NOT NULL', [Number(req.params.id)]);
    if (!u) return reply.code(404).send({ error: 'not_found' });
    return { reader: { id: u.id, screen_name: u.screen_name, avatar: avatarUrl(u.avatar_path), since: u.created_at }, reviews: await many(READER_REVIEWS_SQL, [u.id]) };
  });

  // Admin: newest reviews, to hide one that should not be public.
  app.get('/api/admin/reviews', { preHandler: requireUser(3) }, async () => ({
    reviews: await many(
      `SELECT r.id, r.rating, r.answers, r.hidden, r.updated_at, b.id AS book_id, b.title, u.id AS user_id, u.screen_name
         FROM book_reviews r JOIN books b ON b.id = r.book_id JOIN users u ON u.id = r.user_id
        WHERE r.answers <> '{}'::jsonb ORDER BY r.updated_at DESC LIMIT 100`),
  }));
  app.post('/api/admin/reviews/:id', { preHandler: requireUser(3) }, async (req) => {
    await q('UPDATE book_reviews SET hidden = $2 WHERE id = $1', [Number(req.params.id), !!req.body?.hidden]);
    return { ok: true };
  });
}
