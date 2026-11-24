// Help check (Ami, 24 Nov 2026): books read from shelf photos at public street libraries that
// their photographer left unchecked for a few days (HELP_AFTER_DAYS) can be checked by any
// signed-in volunteer: "Is this the book in the picture?" Right / Not this book / Skip.
// The photographer's queue stays as it was; nothing new is asked of them. Once the volunteers
// agree (helpVerdict), the book is approved or declined exactly as if the photographer had
// decided, the sighting credited to the photographer, and it leaves their queue.
import { config, POINTS } from './config.js';
import { one, many, q, tx } from './db.js';
import { requireUser } from './auth.js';
import { award } from './moderation.js';
import { approveItem, closeIfDone } from './approvals.js';
import { keepForReview } from './scans.js';
import { CROP_SHOWN_SQL } from './confidence.js';
import { parseLatLon } from './util.js';

// A volunteer with at least this trust level settles a book alone: the app's "trusted" reader
// (moderation.js initialStatus: their own reports go live without review).
export const HELP_TRUSTED_LEVEL = 1;
// Low-confidence reads are mostly misreads: not worth a volunteer's time.
export const HELP_MIN_CONFIDENCE = 45;
const HELP_MAX_DAYS = 60;
const COUNT_CAP = 99;

// What volunteers' votes decide: a trusted volunteer's vote settles it; otherwise two say
// "right" with nobody saying "wrong" (approved), or two say "wrong" with nobody saying "right"
// (declined). Mixed votes stay open (for the photographer, or a trusted volunteer).
// votes: [{ vote: true|false, trusted: boolean }] in the order cast.
export function helpVerdict(votes) {
  const trusted = votes.find((v) => v.trusted);
  if (trusted) return trusted.vote ? 'approved' : 'declined';
  const right = votes.filter((v) => v.vote).length;
  const wrong = votes.length - right;
  if (right >= 2 && !wrong) return 'approved';
  if (wrong >= 2 && !right) return 'declined';
  return null;
}

const CONFIDENCE_SQL = `COALESCE(i.confidence, CASE i.quality WHEN 'high' THEN 85 WHEN 'medium' THEN 40 ELSE 20 END)`;

// The books this volunteer may check (`join`: more tables to read from). $1 = the volunteer, $2 = HELP_AFTER_DAYS, $3 = whether
// they are trusted (only trusted volunteers see books whose votes are mixed: nobody else could
// settle them).
export const helpFrom = (join = '') => `
    FROM scan_items i JOIN scans s ON s.id = i.scan_id JOIN locations l ON l.id = s.location_id ${join}
   WHERE s.source IN ('photo', 'video') AND s.status IN ('done', 'confirmed') AND s.situation IS NULL
     AND l.status = 'approved' AND l.merged_into IS NULL
     AND (i.decision IS NULL OR i.decision = 'later') AND NOT i.help_off
     AND i.created_at < now() - make_interval(days => $2) AND i.created_at > now() - interval '${HELP_MAX_DAYS} days'
     AND i.quality <> 'low' AND i.crop_path IS NOT NULL AND ${CROP_SHOWN_SQL}
     AND ${CONFIDENCE_SQL} >= ${HELP_MIN_CONFIDENCE}
     AND s.user_id <> $1
     AND NOT EXISTS (SELECT 1 FROM help_votes v WHERE v.item_id = i.id AND v.user_id = $1)
     AND ($3 OR NOT (EXISTS (SELECT 1 FROM help_votes v WHERE v.item_id = i.id AND v.vote)
                 AND EXISTS (SELECT 1 FROM help_votes v WHERE v.item_id = i.id AND NOT v.vote)))`;

const on = () => config.helpAfterDays > 0;
const args = (user) => [user.id, config.helpAfterDays, user.trust_level >= HELP_TRUSTED_LEVEL];

// How many books wait for this volunteer (capped: it is a badge, not a statistic).
export async function helpCount(user, locationId = null) {
  if (!on() || !user) return 0;
  const r = await one(
    `SELECT count(*)::int AS n FROM (SELECT 1 ${helpFrom()} ${locationId ? 'AND s.location_id = $4' : ''} LIMIT ${COUNT_CAP}) x`,
    locationId ? [...args(user), locationId] : args(user));
  return r.n;
}

// Approves or declines a book the volunteers settled, the way the photographer's own decision
// would (approvals.js POST /api/queue/:id). The decision is claimed first, so two votes at once
// (or the photographer at the same moment) cannot apply it twice.
async function decide(itemId, decision, byUserId, log) {
  const item = await one(
    `UPDATE scan_items SET decision = $2, decided_at = now(), decided_by = $3
      WHERE id = $1 AND (decision IS NULL OR decision = 'later') RETURNING *`, [itemId, decision, byUserId]);
  if (!item) return null;
  if (decision === 'approved') {
    const scan = await one('SELECT * FROM scans WHERE id = $1', [item.scan_id]);
    const owner = await one('SELECT * FROM users WHERE id = $1', [scan.user_id]);
    const r = await approveItem(item, scan, owner).catch((err) => { log.warn({ err, item: item.id }, 'help approve'); return null; });
    if (!r) {
      await q('UPDATE scan_items SET decision = NULL, decided_at = NULL, decided_by = NULL WHERE id = $1', [item.id]);
      return null;
    }
    await q(`UPDATE scan_items SET outcome = 'kept', sighting_id = $2, my_book_id = $3 WHERE id = $1`,
      [item.id, r.sighting?.id ?? null, r.myBookId ?? null]);
    await evidence(item, 'kept', r.book, log);
  } else {
    await q(`UPDATE scan_items SET outcome = 'dropped', decline_why = 'reading' WHERE id = $1`, [item.id]);
    await evidence(item, 'dropped', null, log);
    keepForReview(item, 'dropped', {}).catch((err) => log.warn({ err, item: item.id }, 'keep for review'));
  }
  await closeIfDone(item.scan_id);
  return decision;
}

const evidence = (item, outcome, book, log) => q(
  `INSERT INTO scan_item_evidence(item_id, stage, source, outcome, before, after) VALUES ($1, 'reader', 'helpers', $2, $3, $4)`,
  [item.id, outcome, [item.title, item.author].filter(Boolean).join(' | '),
    book ? [book.title, book.authors?.[0]].filter(Boolean).join(' | ') : null]).catch((err) => log.warn({ err }, 'evidence'));

export default async function helpRoutes(app) {
  // Libraries with books waiting for this volunteer: nearest first when the position is given.
  app.get('/api/help/libraries', { preHandler: requireUser() }, async (req) => {
    const p = parseLatLon(req.query.lat, req.query.lon);
    const points = { vote: POINTS.helpCheck, decided: POINTS.helpDecided };
    if (!on()) return { libraries: [], points };
    const libraries = await many(
      `SELECT l.code, l.name, count(*)::int AS n,
              ${p ? 'round(ST_Distance(l.geom, ST_MakePoint($4, $5)::geography))::int' : 'NULL::int'} AS metres
         ${helpFrom()}
        GROUP BY l.id
        ORDER BY ${p ? 'metres' : 'n DESC'}, l.id LIMIT 30`,
      p ? [...args(req.user), p.lon, p.lat] : args(req.user));
    return { libraries, points };
  });

  // One library's books waiting for this volunteer: the cut-out and what the app thinks it is.
  app.get('/api/help/l/:code', { preHandler: requireUser() }, async (req, reply) => {
    const loc = await one(`SELECT id, code, name FROM locations WHERE code = $1 AND status = 'approved'`, [String(req.params.code).toUpperCase()]);
    if (!loc) return reply.code(404).send({ error: 'not_found' });
    const items = on() ? await many(
      `SELECT i.id, i.crop_path, i.frame_path, i.title AS read_title, i.author AS read_author,
              b.id AS book_id, b.title AS book_title, b.authors AS book_authors, b.cover_url, b.year,
              ${CONFIDENCE_SQL} AS confidence
         ${helpFrom('LEFT JOIN books b ON b.id = i.book_id')} AND s.location_id = $4
        ORDER BY ${CONFIDENCE_SQL} DESC, i.id LIMIT 30`,
      [...args(req.user), loc.id]) : [];
    return {
      location: { code: loc.code, name: loc.name },
      points: { vote: POINTS.helpCheck, decided: POINTS.helpDecided },
      items: items.map((i) => ({
        id: i.id, crop: `/uploads/${i.crop_path}`, frame: i.frame_path && `/uploads/${i.frame_path}`, confidence: i.confidence,
        book_id: i.book_id, title: i.book_id ? i.book_title : i.read_title, authors: i.book_id ? i.book_authors ?? [] : [i.read_author].filter(Boolean),
        cover_url: i.book_id ? i.cover_url : null, year: i.book_id ? i.year : null,
      })),
    };
  });

  // A volunteer's answer: right (true) or not this book (false).
  app.post('/api/help/:id', {
    preHandler: requireUser(),
    config: { rateLimit: { max: 600, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const right = req.body?.right;
    if (typeof right !== 'boolean' || !on()) return reply.code(400).send({ error: 'bad_request' });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const fresh = await tx(async (db) => {
      const ok = (await db.query(`SELECT i.id ${helpFrom()} AND i.id = $4 FOR UPDATE OF i`, [...args(req.user), id])).rowCount;
      if (!ok) return false;
      const n = (await db.query('INSERT INTO help_votes(item_id, user_id, vote) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, req.user.id, right])).rowCount;
      if (n) await award(db, { userId: req.user.id, points: POINTS.helpCheck, reason: 'help_check', refType: 'scan_item', refId: id });
      return n > 0;
    });
    if (!fresh) return reply.code(404).send({ error: 'not_found' });
    const votes = await many(
      `SELECT v.vote, u.trust_level >= $2 AS trusted FROM help_votes v JOIN users u ON u.id = v.user_id
        WHERE v.item_id = $1 ORDER BY v.created_at, v.user_id`, [id, HELP_TRUSTED_LEVEL]);
    const verdict = helpVerdict(votes);
    const decided = verdict ? await decide(id, verdict, req.user.id, req.log) : null;
    // Points are not scarce (Ami, 24 Nov 2026): the photographer keeps the full points for the
    // find (approveItem credits them), every vote earns points, and every volunteer whose vote
    // agreed with the decision gets a bonus.
    if (decided) {
      const agreed = await many('SELECT user_id FROM help_votes WHERE item_id = $1 AND vote = $2', [id, decided === 'approved']);
      await tx(async (db) => {
        for (const v of agreed) await award(db, { userId: v.user_id, points: POINTS.helpDecided, reason: 'help_decided', refType: 'scan_item', refId: id });
      });
    }
    return { decided, points: POINTS.helpCheck + (decided ? POINTS.helpDecided : 0) };
  });
}
