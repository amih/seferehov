// Readers correct mistakes in a book's details: a title or author misread from a spine,
// the publisher, the year, the blurb, or the text read from a cover photo. Anyone may
// suggest a fix, even to what another reader approved.
//
// How fixes are trusted (after Stack Overflow's suggested edits and WikiTrust):
//  - Every change is kept (book_fixes), so any fix can be undone, and an undo is itself a fix.
//  - A reader's fix score is a beta reputation: (accepted + 1) / (accepted + undone + 2),
//    where undone = rejected or later undone by someone else; votes for fixes that were
//    later undone count half against the voter, so reviewers look before they vote.
//  - Fixes by reviewers, and by readers with FIX_LIVE_AFTER accepted fixes and a score of
//    at least FIX_LIVE_SCORE, go live at once. Others wait for votes: a reviewer's vote
//    weighs 2, a trusted reader's 1; 2 for = live, 2 against = rejected.
//  - A reader whose score falls below FIX_MIN_SCORE (after FIX_MIN_DECIDED decided
//    fixes) can still suggest fixes but they always wait for votes, and cannot vote.
//  - How many fixes a day grows with the record, in steps (FIX_DAY_STEPS); a low score
//    drops to FIX_DAY_LOW.
//  - Points only once a fix is live, more when nobody undid it for FIX_KEEP_DAYS;
//    an undone fix loses both. Nothing for merely suggesting.
import { POINTS } from './config.js';
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';
import { award, maybePromote, audit } from './moderation.js';
import { splitAuthors } from './locations.js';
import { BOOK_PHOTOS_SQL } from './seo.js';

const FIX_LIVE_AFTER = 3;
const FIX_LIVE_SCORE = 0.8;
const FIX_MIN_SCORE = 0.6;
const FIX_MIN_DECIDED = 5;
const FIX_VOTES_NEEDED = 2;
const FIX_KEEP_DAYS = 30;
// Fixes a day: the first step whose conditions the reader meets.
const FIX_DAY_STEPS = [
  { trust: 3, limit: 500 },
  { trust: 2, limit: 100 },
  { accepted: 50, score: 0.9, limit: 50 },
  { accepted: 10, score: 0.8, limit: 25 },
  { limit: 10 },
];
const FIX_DAY_LOW = 3;
const dayLimit = (user, accepted, score, low) => (low ? FIX_DAY_LOW
  : FIX_DAY_STEPS.find((s) => user.trust_level >= (s.trust ?? 0) && accepted >= (s.accepted ?? 0) && score >= (s.score ?? 0)).limit);
const FIELDS = { title: 300, authors: 300, publisher: 200, year: 4, description: 4000, cover_text: 8000 };

// The reader's fix record and what it allows.
export async function fixStanding(user) {
  const r = await one(
    `SELECT count(*) FILTER (WHERE status IN ('live', 'superseded'))::int AS accepted,
            count(*) FILTER (WHERE status IN ('rejected', 'reverted'))::int AS undone,
            (SELECT count(*)::int FROM book_fix_votes v JOIN book_fixes f ON f.id = v.fix_id
              WHERE v.user_id = $1 AND v.vote = 1 AND f.status = 'reverted') AS bad_votes,
            count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today
       FROM book_fixes WHERE user_id = $1`, [user.id]);
  const score = (r.accepted + 1) / (r.accepted + r.undone + r.bad_votes / 2 + 2);
  const decided = r.accepted + r.undone;
  const low = decided >= FIX_MIN_DECIDED && score < FIX_MIN_SCORE;
  return {
    ...r, score: Math.round(score * 100) / 100,
    live: !low && (user.trust_level >= 2 || (user.trust_level >= 1 && r.accepted >= FIX_LIVE_AFTER && score >= FIX_LIVE_SCORE)),
    can_vote: !low && user.trust_level >= 1,
    weight: user.trust_level >= 2 ? 2 : 1,
    day_limit: dayLimit(user, r.accepted, score, low),
    left_today: Math.max(0, dayLimit(user, r.accepted, score, low) - r.today),
  };
}

// What a field holds now, as text (authors joined with ", ").
async function currentValue(db, bookId, field, photoId) {
  if (field === 'cover_text') return (await db.query('SELECT ocr_text FROM photos WHERE id = $1', [photoId])).rows[0]?.ocr_text ?? null;
  const b = (await db.query(`SELECT ${field} FROM books WHERE id = $1`, [bookId])).rows[0];
  if (!b) return null;
  return field === 'authors' ? (b.authors ?? []).join(', ') : b[field] == null ? null : String(b[field]);
}

// Puts a fix in place: the book (or the cover photo's text) changes, the fix it undoes
// loses its points, an earlier live fix of the same thing becomes history, and the
// author gets points.
async function applyFix(db, fix, byUserId) {
  const before = await currentValue(db, fix.book_id, fix.field, fix.photo_id);
  const v = fix.new_value;
  if (fix.field === 'cover_text') {
    await db.query(`UPDATE photos SET ocr_text = $2, ocr_status = 'approved' WHERE id = $1`, [fix.photo_id, v]);
  } else {
    const value = fix.field === 'authors' ? splitAuthors(v) : fix.field === 'year' ? (v ? Number(v) : null) : v || null;
    await db.query(
      `UPDATE books SET ${fix.field} = $2, fixed_fields = (SELECT array_agg(DISTINCT f) FROM unnest(fixed_fields || $3::text) f) WHERE id = $1`,
      [fix.book_id, value, fix.field]);
  }
  if (fix.reverts) {
    const undone = (await db.query(
      `UPDATE book_fixes SET status = CASE WHEN user_id = $2 THEN 'withdrawn' ELSE 'reverted' END
        WHERE id = $1 AND status IN ('live', 'superseded') RETURNING id`, [fix.reverts, fix.user_id])).rows[0];
    if (undone) await db.query(`DELETE FROM karma_events WHERE ref_type = 'book_fix' AND ref_id = $1`, [undone.id]);
  }
  await db.query(
    `UPDATE book_fixes SET status = 'superseded'
      WHERE book_id = $1 AND field = $2 AND photo_id IS NOT DISTINCT FROM $3 AND status = 'live' AND id <> $4`,
    [fix.book_id, fix.field, fix.photo_id, fix.id]);
  await db.query(
    `UPDATE book_fixes SET status = 'live', old_value = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
    [fix.id, before, byUserId]);
  // An undo by the fix's own author earns nothing: it takes back their own mistake.
  const own = fix.reverts && (await db.query('SELECT user_id FROM book_fixes WHERE id = $1', [fix.reverts])).rows[0]?.user_id === fix.user_id;
  if (!own) await award(db, { userId: fix.user_id, points: POINTS.fix, reason: 'book_fix', refType: 'book_fix', refId: fix.id, by: byUserId });
  await maybePromote(db, fix.user_id);
}

// One suggested change: replaces the reader's own waiting fix of the same thing, then
// goes live at once or waits for votes. Returns 'live', 'pending' or null (no change).
async function suggest(user, standing, { bookId, field, photoId = null, value, note = null, reverts = null }) {
  return tx(async (db) => {
    const now = await currentValue(db, bookId, field, photoId);
    if ((now ?? '') === (value ?? '')) return null;
    await db.query(
      `DELETE FROM book_fixes WHERE book_id = $1 AND field = $2 AND photo_id IS NOT DISTINCT FROM $3 AND user_id = $4 AND status = 'pending'`,
      [bookId, field, photoId, user.id]);
    const fix = (await db.query(
      `INSERT INTO book_fixes(book_id, user_id, field, photo_id, old_value, new_value, note, reverts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [bookId, user.id, field, photoId, now, value, note, reverts])).rows[0];
    if (!standing.live) return 'pending';
    await applyFix(db, fix, user.id);
    return 'live';
  });
}

function clean(field, v) {
  let s = String(v ?? '').replace(/\r/g, '').trim();
  s = field === 'description' || field === 'cover_text' ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  if (field === 'year' && s && !(/^\d{4}$/.test(s) && Number(s) >= 1400 && Number(s) <= new Date().getFullYear() + 1)) return undefined;
  if (field === 'title' && !s) return undefined;
  return s.slice(0, FIELDS[field]);
}

// The cover photos of a book whose text can be fixed (rejected reads are not shown anywhere).
async function bookTexts(bookId) {
  return (await many(BOOK_PHOTOS_SQL, [bookId]))
    .filter((p) => p.ocr_text && p.ocr_status !== 'rejected')
    .map((p) => ({ photo_id: p.id, kind: p.kind, text: p.ocr_text, url: `/uploads/${p.thumb_path || p.path}` }));
}

const FIX_ROW_SQL = `
  SELECT f.id, f.book_id, f.field, f.photo_id, p.kind AS photo_kind, f.old_value, f.new_value, f.note, f.reverts, f.status,
         f.created_at, f.decided_at, f.user_id, COALESCE(u.screen_name, 'Reader #' || u.id) AS by_name,
         COALESCE((SELECT sum(weight) FROM book_fix_votes WHERE fix_id = f.id AND vote = 1), 0)::int AS up,
         COALESCE((SELECT sum(weight) FROM book_fix_votes WHERE fix_id = f.id AND vote = -1), 0)::int AS down,
         (SELECT vote FROM book_fix_votes WHERE fix_id = f.id AND user_id = $2) AS my_vote
    FROM book_fixes f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN photos p ON p.id = f.photo_id`;

// A live fix can be undone when it is still what the page shows.
const undoable = (f) => f.status === 'live';

// Points for fixes that stayed: nobody undid them for FIX_KEEP_DAYS.
async function awardKept(log) {
  try {
    const rows = await many(
      `UPDATE book_fixes SET kept_awarded = true
        WHERE status IN ('live', 'superseded') AND NOT kept_awarded AND decided_at < now() - interval '${FIX_KEEP_DAYS} days'
        RETURNING id, user_id`);
    for (const r of rows) await tx((db) => award(db, { userId: r.user_id, points: POINTS.fixKept, reason: 'book_fix_kept', refType: 'book_fix', refId: r.id }));
  } catch (err) { log.error(err, 'fix points'); }
}
export function startFixWorker(log) {
  setTimeout(() => awardKept(log), 60_000).unref();
  setInterval(() => awardKept(log), 3600_000).unref();
}

// Undoes a live fix (as `user`): a new fix back to what was there before it.
async function undoFix(user, standing, fixId) {
  const f = await one('SELECT * FROM book_fixes WHERE id = $1', [fixId]);
  if (!f || !undoable(f)) return { error: 'not_live' };
  const r = await suggest(user, standing, { bookId: f.book_id, field: f.field, photoId: f.photo_id, value: f.old_value ?? '', reverts: f.id });
  return { result: r };
}

export default async function fixRoutes(app) {
  // The book's fixable details, its cover texts, and the history of fixes.
  app.get('/api/books/:id/fixes', async (req, reply) => {
    const id = Number(req.params.id);
    const b = await one('SELECT id, title, authors, publisher, year, description FROM books WHERE id = $1', [id]);
    if (!b) return reply.code(404).send({ error: 'not_found' });
    const history = await many(`${FIX_ROW_SQL} WHERE f.book_id = $1 ORDER BY f.created_at DESC LIMIT 60`, [id, req.user?.id ?? null]);
    return {
      book: { ...b, authors: (b.authors ?? []).join(', '), year: b.year ? String(b.year) : '' },
      texts: await bookTexts(id),
      history: history.map((f) => ({ ...f, undoable: undoable(f), mine: f.user_id === req.user?.id })),
      me: req.user ? await fixStanding(req.user) : null,
    };
  });

  // Suggest fixes: { changes: { title, authors, publisher, year, description }, texts: { <photo id>: text }, note }.
  app.post('/api/books/:id/fixes', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!await one('SELECT 1 FROM books WHERE id = $1', [id])) return reply.code(404).send({ error: 'not_found' });
    const standing = await fixStanding(req.user);
    const { changes = {}, texts = {}, note = null } = req.body ?? {};
    const wanted = [];
    for (const field of ['title', 'authors', 'publisher', 'year', 'description']) {
      if (!(field in changes)) continue;
      const value = clean(field, changes[field]);
      if (value === undefined) return reply.code(400).send({ error: `bad_${field}` });
      wanted.push({ field, value });
    }
    if (Object.keys(texts).length) {
      const mine = new Set((await bookTexts(id)).map((x) => x.photo_id));
      for (const [photoId, text] of Object.entries(texts)) {
        if (!mine.has(photoId)) return reply.code(400).send({ error: 'bad_photo' });
        wanted.push({ field: 'cover_text', photoId, value: clean('cover_text', text) });
      }
    }
    if (wanted.length > standing.left_today) return reply.code(429).send({ error: 'too_many_fixes' });
    const n = { live: 0, pending: 0 };
    const why = note ? String(note).trim().slice(0, 300) || null : null;
    for (const w of wanted) {
      const r = await suggest(req.user, standing, { bookId: id, ...w, note: why });
      if (r) n[r]++;
    }
    if (n.live || n.pending) await audit(req.user.id, 'book_fix', 'book', id, n);
    return n;
  });

  app.post('/api/fixes/:id/undo', { preHandler: requireUser(), config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const standing = await fixStanding(req.user);
    if (!standing.left_today) return reply.code(429).send({ error: 'too_many_fixes' });
    const r = await undoFix(req.user, standing, Number(req.params.id));
    if (r.error) return reply.code(409).send({ error: r.error });
    await audit(req.user.id, 'book_fix_undo', 'book_fix', Number(req.params.id));
    return { status: r.result };
  });

  // Fixes waiting for votes, for readers who may vote (not their own, not voted yet).
  app.get('/api/fixes', { preHandler: requireUser(1) }, async (req) => {
    const standing = await fixStanding(req.user);
    if (!standing.can_vote) return { items: [], me: standing };
    const items = await many(
      `${FIX_ROW_SQL} WHERE f.status = 'pending' AND f.user_id IS DISTINCT FROM $1
          AND NOT EXISTS (SELECT 1 FROM book_fix_votes WHERE fix_id = f.id AND user_id = $1) AND $2::bigint = $1
          AND NOT EXISTS (SELECT 1 FROM book_fixes r WHERE r.id = f.reverts AND r.user_id = $1)
        ORDER BY f.created_at LIMIT 100`, [req.user.id, req.user.id]);
    const books = new Map((await many(
      `SELECT b.id, b.title, b.authors, COALESCE(b.front_url, b.cover_url) AS cover,
              (SELECT COALESCE(p.thumb_path, p.path) FROM photos p WHERE p.id IN (
                 SELECT s.photo_id FROM sightings s WHERE s.book_id = b.id AND s.status = 'approved'
                 UNION SELECT m.photo_id FROM my_books m WHERE m.book_id = b.id) ORDER BY p.created_at DESC LIMIT 1) AS photo
         FROM books b WHERE b.id = ANY($1)`, [[...new Set(items.map((i) => i.book_id))]])).map((b) => [b.id, b]));
    const photos = new Map((await many('SELECT id, COALESCE(thumb_path, path) AS p FROM photos WHERE id = ANY($1)',
      [items.map((i) => i.photo_id).filter(Boolean)])).map((p) => [p.id, `/uploads/${p.p}`]));
    return {
      items: items.map((f) => {
        const b = books.get(f.book_id);
        return { ...f, title: b?.title, cover: f.photo_id ? photos.get(f.photo_id) : b?.photo ? `/uploads/${b.photo}` : b?.cover ?? null };
      }),
      me: standing,
    };
  });

  app.post('/api/fixes/:id/vote', { preHandler: requireUser(1) }, async (req, reply) => {
    const vote = Number(req.body?.vote);
    if (![1, -1].includes(vote)) return reply.code(400).send({ error: 'bad_request' });
    const standing = await fixStanding(req.user);
    if (!standing.can_vote) return reply.code(403).send({ error: 'forbidden' });
    const id = Number(req.params.id);
    const status = await tx(async (db) => {
      const fix = (await db.query(`SELECT * FROM book_fixes WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id])).rows[0];
      if (!fix) return 'gone';
      if (fix.user_id === req.user.id) return 'own';
      // Nor on an undo of their own fix.
      if (fix.reverts && (await db.query('SELECT 1 FROM book_fixes WHERE id = $1 AND user_id = $2', [fix.reverts, req.user.id])).rowCount) return 'own';
      const had = (await db.query(
        `INSERT INTO book_fix_votes(fix_id, user_id, vote, weight) VALUES ($1, $2, $3, $4)
         ON CONFLICT (fix_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, weight = EXCLUDED.weight
         RETURNING (xmax <> 0) AS again`, [id, req.user.id, vote, standing.weight])).rows[0].again;
      if (!had) await award(db, { userId: req.user.id, points: POINTS.fixVote, reason: 'fix_vote', refType: 'book_fix', refId: id });
      const { up, down } = (await db.query(
        `SELECT COALESCE(sum(weight) FILTER (WHERE vote = 1), 0)::int AS up, COALESCE(sum(weight) FILTER (WHERE vote = -1), 0)::int AS down
           FROM book_fix_votes WHERE fix_id = $1`, [id])).rows[0];
      if (up >= FIX_VOTES_NEEDED && up > down) { await applyFix(db, fix, req.user.id); return 'live'; }
      if (down >= FIX_VOTES_NEEDED && down > up) {
        await db.query(`UPDATE book_fixes SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`, [id, req.user.id]);
        return 'rejected';
      }
      return 'pending';
    });
    if (status === 'gone') return reply.code(409).send({ error: 'already_decided' });
    if (status === 'own') return reply.code(403).send({ error: 'own_fix' });
    return { status };
  });

  // Admin, against vandalism: every live fix of one reader undone, their waiting ones rejected.
  app.post('/api/admin/readers/:id/revert-fixes', { preHandler: requireUser(3) }, async (req) => {
    const userId = Number(req.params.id);
    const standing = { live: true };
    const live = await many(`SELECT id FROM book_fixes WHERE user_id = $1 AND status = 'live' ORDER BY created_at DESC`, [userId]);
    let undone = 0;
    for (const f of live) if ((await undoFix(req.user, standing, f.id)).result === 'live') undone++;
    const rejected = (await q(
      `UPDATE book_fixes SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE user_id = $1 AND status = 'pending'`,
      [userId, req.user.id])).rowCount;
    await audit(req.user.id, 'revert_fixes', 'user', userId, { undone, rejected });
    return { undone, rejected };
  });
}

// For the to-do counts: fixes this reader may vote on.
export async function fixesToVote(user) {
  if (user.trust_level < 1 || !(await fixStanding(user)).can_vote) return 0;
  return (await one(
    `SELECT count(*)::int AS n FROM book_fixes f WHERE f.status = 'pending' AND f.user_id IS DISTINCT FROM $1
        AND NOT EXISTS (SELECT 1 FROM book_fix_votes WHERE fix_id = f.id AND user_id = $1)
        AND NOT EXISTS (SELECT 1 FROM book_fixes r WHERE r.id = f.reverts AND r.user_id = $1)`, [user.id])).n;
}
