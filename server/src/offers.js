// The reader's own books offered for sale or to give away. A home library stays private:
// only the books the owner offers are shown, with the town and the owner's screen name,
// never an address or e-mail. A buyer writes through the app; the message is e-mailed to
// the owner with the buyer's address to reply to (the buyer is told so before sending).
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { config } from './config.js';
import { sendMail } from './mail.js';
import { patternCheck } from './privacy.js';
import { bookPath } from './seo.js';

const CONDITIONS = ['new', 'like_new', 'good', 'fair'];
const MESSAGES_PER_DAY = 20;

// Offers of one book (or the latest anywhere), for its page and the offers list.
export const OFFERS_SQL = `
  SELECT m.id, m.book_id, m.offer, m.price, m.condition, m.offer_note, m.offered_at, m.user_id, m.offer_place_id,
         u.screen_name, p.name AS place, p.name_he AS place_he, ph.thumb_path
    FROM my_books m JOIN users u ON u.id = m.user_id LEFT JOIN places p ON p.id = m.offer_place_id
    LEFT JOIN photos ph ON ph.id = m.photo_id
   WHERE m.offer IS NOT NULL AND m.placed_at IS NULL AND u.screen_name IS NOT NULL`;

const TEXT = {
  he: {
    subject: (title) => `מישהו מעוניין בספר "${title}"`,
    body: ({ title, name, text, url }) => `${name} כתב/ה לך דרך ספרחוב על הספר "${title}" שהצעת:\n\n${text}\n\nכדי לענות, השיבו למייל הזה (התשובה תגיע ישירות אל ${name}).\nההצעה: ${url}\nכדי להוריד את ההצעה: ${config.baseUrl}/books\n\nספרחוב`,
  },
  en: {
    subject: (title) => `Someone is interested in "${title}"`,
    body: ({ title, name, text, url }) => `${name} wrote to you on Seferehov about "${title}", which you offered:\n\n${text}\n\nTo answer, reply to this e-mail (it goes straight to ${name}).\nThe offer: ${url}\nTo take the offer down: ${config.baseUrl}/books\n\nSeferehov`,
  },
};

export default async function offerRoutes(app) {
  // Offer one of my books, or change the offer. The town is remembered for the next one.
  app.put('/api/my-books/:id/offer', { preHandler: requireUser() }, async (req, reply) => {
    const m = await one(`SELECT id FROM my_books WHERE id = $1 AND user_id = $2 AND placed_at IS NULL AND owner = 'mine'`, [Number(req.params.id), req.user.id]);
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const b = req.body ?? {};
    const offer = ['sale', 'give'].includes(b.offer) ? b.offer : null;
    const price = offer === 'sale' ? Math.round(Number(b.price)) : null;
    if (!offer) return reply.code(400).send({ error: 'offer_required' });
    if (offer === 'sale' && !(price >= 1 && price <= 100000)) return reply.code(400).send({ error: 'price_required' });
    const place = await one('SELECT id FROM places WHERE id = $1', [Number(b.place_id) || 0]);
    if (!place) return reply.code(400).send({ error: 'place_required' });
    const note = String(b.note ?? '').trim().slice(0, 300) || null;
    // The note is public: contact goes through the app, not a phone number in it.
    const snippets = patternCheck(note);
    if (snippets.length) return reply.code(422).send({ error: 'private_info', snippets });
    await q(
      `UPDATE my_books SET offer = $2, price = $3, condition = $4, offer_note = $5, offer_place_id = $6, offered_at = COALESCE(offered_at, now())
        WHERE id = $1`,
      [m.id, offer, price, CONDITIONS.includes(b.condition) ? b.condition : null, note, place.id]);
    await q('UPDATE users SET home_place_id = $2 WHERE id = $1', [req.user.id, place.id]);
    return { ok: true };
  });

  app.delete('/api/my-books/:id/offer', { preHandler: requireUser() }, async (req) => {
    await q('UPDATE my_books SET offer = NULL, price = NULL, offered_at = NULL WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
    return { ok: true };
  });

  // The reader's remembered town, for the offer form.
  app.get('/api/me/home-place', { preHandler: requireUser() }, async (req) => ({
    place: await one(`SELECT p.id, p.name, p.name_he FROM users u JOIN places p ON p.id = u.home_place_id WHERE u.id = $1`, [req.user.id]),
  }));

  // Books offered lately, anywhere or in one town.
  app.get('/api/offers', async (req) => {
    const place = Number(req.query.place) || null;
    const kind = ['sale', 'give'].includes(req.query.kind) ? req.query.kind : null;
    const rows = await many(
      `SELECT o.*, b.title, b.authors, COALESCE(b.front_url, b.cover_url) AS cover_url
         FROM (${OFFERS_SQL} AND ($1::bigint IS NULL OR m.offer_place_id = $1) AND ($2::text IS NULL OR m.offer = $2)) o
         JOIN books b ON b.id = o.book_id
        ORDER BY o.offered_at DESC LIMIT 100`, [place, kind]);
    return { offers: rows.map(({ thumb_path, ...r }) => ({ ...r, path: bookPath({ id: r.book_id, title: r.title }), photo: thumb_path ? `/uploads/${thumb_path}` : null, mine: r.user_id === req.user?.id })) };
  });

  // A buyer writes to the owner.
  app.post('/api/offers/:id/contact', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (text.length < 5) return reply.code(400).send({ error: 'text_required' });
    const o = await one(
      `SELECT m.id, m.user_id, u.email, (SELECT lang FROM scans WHERE user_id = m.user_id ORDER BY created_at DESC LIMIT 1) AS lang, b.id AS book_id, b.title FROM my_books m JOIN users u ON u.id = m.user_id JOIN books b ON b.id = m.book_id
        WHERE m.id = $1 AND m.offer IS NOT NULL AND m.placed_at IS NULL`, [Number(req.params.id)]);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    if (o.user_id === req.user.id) return reply.code(400).send({ error: 'own_offer' });
    const today = await one(`SELECT count(*)::int AS n FROM offer_messages WHERE from_user = $1 AND created_at > now() - interval '1 day'`, [req.user.id]);
    if (today.n >= MESSAGES_PER_DAY) return reply.code(429).send({ error: 'too_many' });
    const me = await one('SELECT email, screen_name FROM users WHERE id = $1', [req.user.id]);
    await q('INSERT INTO offer_messages(my_book_id, from_user, body) VALUES ($1, $2, $3)', [o.id, req.user.id, text]);
    const T = TEXT[o.lang === 'en' ? 'en' : 'he'];
    await sendMail({ to: o.email, replyTo: me.email, subject: T.subject(o.title),
      text: T.body({ title: o.title, name: me.screen_name, text, url: config.baseUrl + bookPath({ id: o.book_id, title: o.title }) }) }, req.log);
    return { ok: true };
  });
}
