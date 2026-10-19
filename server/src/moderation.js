import { config, POINTS, KARMA_DAY_CAP, ADMIN_POINTS_DIVISOR } from './config.js';
import { q } from './db.js';

// Content from trusted users is published straight away unless something
// looks off (e.g. the reporter was far from the library).
export function initialStatus(user, { far = false } = {}) {
  return user.trust_level >= 1 && !far ? 'approved' : 'pending';
}

// New libraries and changes to libraries: reviewed unless an admin made them.
export function locationStatus(user) {
  if (user.trust_level >= 3) return 'approved';
  return config.reviewAllLocations ? 'pending' : initialStatus(user);
}

// At most KARMA_DAY_CAP points a day, so tapping buttons cannot make anyone a Guardian.
// Admins get a tenth: they need no encouragement, and readers should lead the board.
export async function award(db, { userId, points, reason, refType, refId, by = null }) {
  if (!userId) return;
  const { today, admin } = (await db.query(
    `SELECT COALESCE((SELECT sum(points) FROM karma_events WHERE user_id = $1 AND created_at > date_trunc('day', now())), 0)::int AS today,
            (SELECT trust_level >= 3 FROM users WHERE id = $1) AS admin`, [userId])).rows[0];
  if (admin && points > 0) points = Math.max(1, Math.round(points / ADMIN_POINTS_DIVISOR));
  points = Math.min(points, KARMA_DAY_CAP - today);
  if (points <= 0) return;
  await db.query(
    `INSERT INTO karma_events(user_id, points, reason, ref_type, ref_id, awarded_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, points, reason, refType, refId, by],
  );
}

export const pointsForSighting = (kind) => (kind === 'seen' || kind === 'added' ? POINTS.sighting : kind === 'taken' ? POINTS.taken : POINTS.gone);

// Points for one report of a book at a library: none for the same report (same book,
// same kind) by the same reader there within a day. Three or more books there today: the shelf bonus.
export async function awardSighting(db, { userId, locationId, bookId, kind, sightingId }) {
  const again = (await db.query(
    `SELECT 1 FROM sightings WHERE user_id = $1 AND location_id = $2 AND book_id = $3 AND id <> $4 AND kind = $5
        AND status = 'approved' AND created_at > now() - interval '1 day' LIMIT 1`, [userId, locationId, bookId, sightingId, kind])).rowCount;
  if (!again) await award(db, { userId, points: pointsForSighting(kind), reason: `sighting_${kind}`, refType: 'sighting', refId: sightingId });
  if (kind !== 'seen' && kind !== 'added') return;
  const { n } = (await db.query(
    `SELECT count(DISTINCT book_id)::int AS n FROM sightings WHERE user_id = $1 AND location_id = $2
        AND kind IN ('seen', 'added') AND status = 'approved' AND created_at > now() - interval '1 day'`, [userId, locationId])).rows[0];
  if (n < 3) return;
  const had = (await db.query(
    `SELECT 1 FROM karma_events WHERE user_id = $1 AND reason = 'shelf' AND ref_id = $2 AND created_at > now() - interval '1 day'`, [userId, locationId])).rowCount;
  if (!had) await award(db, { userId, points: POINTS.shelf, reason: 'shelf', refType: 'location', refId: locationId });
}

// After N approved contributions a new user becomes trusted.
export async function maybePromote(db, userId) {
  if (!userId) return;
  await db.query(
    `UPDATE users SET trust_level = 1
      WHERE id = $1 AND trust_level = 0
        AND (SELECT count(*) FROM locations WHERE created_by = $1 AND status = 'approved')
          + (SELECT count(*) FROM sightings WHERE user_id = $1 AND status = 'approved') >= $2`,
    [userId, config.trustThreshold],
  );
}

export async function audit(userId, action, refType, refId, detail = null) {
  await q('INSERT INTO audit_log(user_id, action, ref_type, ref_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, refType, refId, detail]);
}

