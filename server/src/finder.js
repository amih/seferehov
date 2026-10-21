// Finding books: search by title/author near a point, and watches that email a reader
// when a book they want is reported on a shelf (at one library, within N km, or anywhere).
import { config } from './config.js';
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';
import { sendMail } from './mail.js';
import { sendPush } from './push.js';
import { parseLatLon } from './util.js';

const KM_CHOICES = [1, 5, 20, 50];
const TAKEN_DAYS = 180;        // a taken book is still shown ("was here") this long
const RESULTS = 30;
const NOTIFY_EVERY_MIN = Number(process.env.WATCH_NOTIFY_MINUTES || 30);
const WATCH_QUIET_H = 20;      // at most one email per watch per this many hours

const placeLabel = (r, lang) => (lang === 'he' && r.place_he) || r.place || null;

// How many readers wait for each book (not counting `userId`), and whether `userId` does.
export async function waitingFor(bookIds, userId) {
  if (!bookIds.length) return new Map();
  const rows = await many(
    `SELECT book_id, count(*) FILTER (WHERE user_id IS DISTINCT FROM $2)::int AS others, bool_or(user_id = $2) AS mine
       FROM book_watches WHERE book_id = ANY($1) GROUP BY book_id`, [bookIds, userId ?? null]);
  return new Map(rows.map((r) => [r.book_id, { others: r.others, mine: !!r.mine }]));
}

export async function searchBooks({ text, pos, km, lang, userId }) {
  // Every parameter is referenced in every variant (Postgres must know their types).
  const where = 'AND ($4::int IS NULL OR ST_DWithin(l.geom, ST_MakePoint($3::float8, $2::float8)::geography, $4 * 1000))';
  const params = [text || null, pos?.lat ?? null, pos?.lon ?? null, km ?? null, TAKEN_DAYS];
  // With text: books matching it. Without: every book on a shelf in the area (or anywhere), newest first.
  const books = text
    ? `SELECT b.id, word_similarity(search_norm($1), b.search) AS score FROM books b
        WHERE search_norm($1) <% b.search OR b.search LIKE '%' || search_norm($1) || '%'
        ORDER BY score DESC LIMIT 300`
    : `SELECT s.book_id AS id, 1.0::real AS score FROM sightings s JOIN locations l ON l.id = s.location_id
        WHERE s.status = 'approved' AND $1::text IS NULL ${where}
        GROUP BY s.book_id ORDER BY max(s.created_at) DESC LIMIT 1000`;
  const rows = await many(
    `WITH m AS (${books}),
     latest AS (
       SELECT DISTINCT ON (s.location_id, s.book_id) s.location_id, s.book_id, s.kind, s.created_at, m.score
         FROM sightings s JOIN m ON m.id = s.book_id
        WHERE s.status = 'approved'
        ORDER BY s.location_id, s.book_id, s.created_at DESC)
     SELECT lt.book_id, lt.kind IN ('seen', 'added') AS present, lt.created_at AS at, lt.score,
            l.code, l.name, p.name AS place, p.name_he AS place_he,
            CASE WHEN $2::float8 IS NULL THEN NULL
                 ELSE ST_Distance(l.geom, ST_MakePoint($3::float8, $2::float8)::geography)::int END AS distance_m
       FROM latest lt JOIN locations l ON l.id = lt.location_id AND l.status = 'approved'
       LEFT JOIN places p ON p.id = l.place_id
      WHERE (lt.kind IN ('seen', 'added') OR lt.created_at > now() - make_interval(days => $5)) ${where}`,
    params,
  );
  const byBook = new Map();
  for (const r of rows) {
    const b = byBook.get(r.book_id) ?? { id: r.book_id, score: r.score, places: [] };
    b.places.push({ code: r.code, name: r.name, place: placeLabel(r, lang), present: r.present, at: r.at, distance_m: r.distance_m });
    byBook.set(r.book_id, b);
  }
  const list = [...byBook.values()];
  for (const b of list) {
    b.places.sort((x, y) => (y.present - x.present) || ((x.distance_m ?? 0) - (y.distance_m ?? 0)) || (new Date(y.at) - new Date(x.at)));
    b.present = b.places.some((p) => p.present);
    b.nearest = Math.min(...b.places.map((p) => p.distance_m ?? Infinity));
    b.latest = Math.max(...b.places.map((p) => new Date(p.at)));
  }
  list.sort((x, y) => (y.present - x.present) || (y.score - x.score) || (x.nearest - y.nearest) || (y.latest - x.latest));
  const top = list.slice(0, RESULTS);
  const details = top.length ? await many(
    'SELECT id, title, authors, year, cover_url FROM books WHERE id = ANY($1)', [top.map((b) => b.id)]) : [];
  const byId = new Map(details.map((d) => [d.id, d]));
  const waiting = await waitingFor(top.map((b) => b.id), userId);
  return top.map(({ score, nearest, latest, ...b }) => ({ ...byId.get(b.id), ...b, places: b.places.slice(0, 8), waiting: waiting.get(b.id) ?? null }));
}

export default async function finderRoutes(app) {
  app.get('/api/books/search', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const text = String(req.query.q ?? '').trim().slice(0, 100);
    const pos = parseLatLon(req.query.lat, req.query.lon);
    const km = KM_CHOICES.includes(Number(req.query.km)) ? Number(req.query.km) : null;
    if (text && text.length < 2) return { books: [] };
    return { books: await searchBooks({ text, pos, km, lang: req.query.lang === 'en' ? 'en' : 'he', userId: req.user?.id }) };
  });

  // Towns with libraries, for "search around a town" when the reader does not share a
  // location; any=1: every town (where an offered book is).
  app.get('/api/places/search', async (req) => {
    const text = String(req.query.q ?? '').trim().slice(0, 60);
    if (text.length < 2) return { places: [] };
    const places = await many(
      `SELECT p.id, p.name, p.name_he, p.country, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lon
         FROM places p
        WHERE (p.name ILIKE $1 || '%' OR p.name_he LIKE $1 || '%')
          AND ($2 OR EXISTS (SELECT 1 FROM locations l WHERE l.place_id = p.id AND l.status = 'approved'))
        ORDER BY p.population DESC LIMIT 8`, [text, req.query.any === '1']);
    return { places };
  });

  app.get('/api/watches', { preHandler: requireUser() }, async (req) => ({
    watches: await many(
      `SELECT w.id, w.kind, w.query, w.scope, w.km, w.created_at, w.notified_at, b.id AS book_id, b.title, b.authors,
              l.code, l.name AS location_name
         FROM book_watches w LEFT JOIN books b ON b.id = w.book_id LEFT JOIN locations l ON l.id = w.location_id
        WHERE w.user_id = $1 ORDER BY w.created_at DESC`, [req.user.id]),
  }));

  app.post('/api/watches', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const { book_id, scope, code, lat, lon, km, lang } = req.body ?? {};
    // A book, or every book by an author, or every book with these words in its title.
    const kind = ['author', 'words'].includes(req.body?.kind) ? req.body.kind : 'book';
    const query = kind === 'book' ? null : (await one('SELECT search_norm($1) AS s', [String(req.body?.query ?? '').slice(0, 100)])).s;
    const book = kind === 'book' ? await one('SELECT id FROM books WHERE id = $1', [Number(book_id)]) : null;
    if ((kind === 'book' ? !book : !query || query.length < 2) || !['here', 'near', 'anywhere'].includes(scope)) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    let locationId = null, center = null, radius = null;
    if (scope === 'here') {
      locationId = (await one(`SELECT id FROM locations WHERE code = $1 AND status = 'approved'`, [String(code ?? '').toUpperCase()]))?.id;
      if (!locationId) return reply.code(400).send({ error: 'bad_request' });
    }
    if (scope === 'near') {
      center = parseLatLon(lat, lon);
      radius = KM_CHOICES.includes(Number(km)) ? Number(km) : null;
      if (!center || !radius) return reply.code(400).send({ error: 'bad_request' });
    }
    const values = [req.user.id, book?.id ?? null, scope, locationId, center?.lat ?? null, center?.lon ?? null, radius, lang === 'en' ? 'en' : 'he'];
    if (kind !== 'book') {
      return {
        watch: await one(
          `INSERT INTO book_watches(user_id, book_id, scope, location_id, center, km, lang, kind, query)
           VALUES ($1, $2, $3, $4, CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_MakePoint($6, $5)::geography END, $7, $8, $9, $10)
           ON CONFLICT (user_id, kind, query) WHERE query IS NOT NULL DO UPDATE SET scope = EXCLUDED.scope, location_id = EXCLUDED.location_id,
             center = EXCLUDED.center, km = EXCLUDED.km, lang = EXCLUDED.lang, created_at = now(), notified_at = NULL
           RETURNING id`, [...values, kind, query]),
      };
    }
    const w = await one(
      `INSERT INTO book_watches(user_id, book_id, scope, location_id, center, km, lang)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_MakePoint($6, $5)::geography END, $7, $8)
       ON CONFLICT (user_id, book_id) DO UPDATE SET scope = EXCLUDED.scope, location_id = EXCLUDED.location_id,
         center = EXCLUDED.center, km = EXCLUDED.km, lang = EXCLUDED.lang, created_at = now(), notified_at = NULL
       RETURNING id`,
      values,
    );
    return { watch: w };
  });

  app.delete('/api/watches/:id', { preHandler: requireUser() }, async (req) => {
    await q('DELETE FROM book_watches WHERE id = $1 AND user_id = $2', [Number(req.params.id), req.user.id]);
    return { ok: true };
  });
}

// ---- emails for watches
const MAIL = {
  he: {
    subject: (title) => `📚 "${title}" נמצא על מדף`,
    body: ({ title, lib, place, link }) => `שלום,\n\nהספר "${title}" דווח עכשיו על המדף ${/^[\u0590-\u05FF]/.test(lib) ? 'ב' : 'ב־'}${lib}${place ? ` (${place})` : ''}.\n\n${link}\n\nכדאי למהר — ספרים ברחוב לא מחכים הרבה זמן.\n\nלהפסקת ההתראות, או כדי לקבל אותן בטלפון במקום במייל: ${config.baseUrl}/settings#notify\n\nספרחוב`,
    push: ({ lib }) => `על המדף ${/^[\u0590-\u05FF]/.test(lib) ? 'ב' : 'ב־'}${lib} עכשיו`,
  },
  en: {
    subject: (title) => `📚 "${title}" is on a shelf`,
    body: ({ title, lib, place, link }) => `Hi,\n\n"${title}" was just reported on the shelf at ${lib}${place ? ` (${place})` : ''}.\n\n${link}\n\nBetter hurry — street books do not wait long.\n\nTo stop these alerts, or to get them on your phone instead of by email: ${config.baseUrl}/settings#notify\n\nSeferehov`,
    push: ({ lib }) => `On the shelf at ${lib} now`,
  },
};

export function startWatchNotifier(log) {
  const run = () => notifyWatchers(log).catch((err) => log.error({ err }, 'watch notify failed'));
  setTimeout(run, 20_000).unref();
  setInterval(run, NOTIFY_EVERY_MIN * 60_000).unref();
}

async function notifyWatchers(log) {
  // Decided reports only; pending ones wait for review.
  const todo = await many(
    `SELECT s.id, s.book_id, s.location_id, s.user_id, s.kind, s.status
       FROM sightings s WHERE NOT s.watch_checked AND s.status <> 'pending' ORDER BY s.id LIMIT 500`);
  for (const s of todo) {
    if (s.status === 'approved' && (s.kind === 'seen' || s.kind === 'added')) {
      const hits = await many(
        // The book itself, any book by a watched author, or with all the watched words.
        `SELECT DISTINCT ON (w.user_id) w.id, w.lang, w.user_id, u.email, u.notify_email, u.notify_push, b.title,
                l.code, l.name AS lib, p.name AS place, p.name_he AS place_he
           FROM books b JOIN book_watches w ON CASE w.kind
                  WHEN 'book' THEN w.book_id = b.id
                  WHEN 'author' THEN EXISTS (SELECT 1 FROM unnest(b.authors) a WHERE search_norm(a) LIKE '%' || w.query || '%')
                  ELSE NOT EXISTS (SELECT 1 FROM unnest(string_to_array(w.query, ' ')) x WHERE position(x IN b.search) = 0) END
           JOIN users u ON u.id = w.user_id
           JOIN locations l ON l.id = $2 LEFT JOIN places p ON p.id = l.place_id
          WHERE b.id = $1 AND w.user_id IS DISTINCT FROM $3
            AND (w.notified_at IS NULL OR w.notified_at < now() - make_interval(hours => $4))
            AND (w.scope = 'anywhere' OR (w.scope = 'here' AND w.location_id = $2)
                 OR (w.scope = 'near' AND ST_DWithin(w.center, l.geom, w.km * 1000)))
          ORDER BY w.user_id, (w.kind = 'book') DESC`,
        [s.book_id, s.location_id, s.user_id, WATCH_QUIET_H]);
      for (const h of hits) {
        const T = MAIL[h.lang] ?? MAIL.he;
        const lib = h.lib || (h.lang === 'en' ? 'a street library' : 'ספריית רחוב');
        const place = h.lang === 'he' ? (h.place_he || h.place) : h.place;
        try {
          const link = `${config.baseUrl}/l/${h.code}`;
          // Each way the reader chose on /me: the phone, email, or both.
          if (h.notify_push) await sendPush(h.user_id, { title: `📚 ${h.title}`, body: T.push({ lib }), url: `/l/${h.code}` }, log);
          if (h.notify_email) await sendMail({ to: h.email, subject: T.subject(h.title), text: T.body({ title: h.title, lib, place, link }) }, log);
          await q('UPDATE book_watches SET notified_at = now() WHERE id = $1', [h.id]);
        } catch (err) { log.error({ err }, 'watch mail failed'); }
      }
    }
    await q('UPDATE sightings SET watch_checked = true WHERE id = $1', [s.id]);
  }
}
