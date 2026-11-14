// /admin/outlines: the admin fixes spine outlines by hand (scan_items.spot). Two lists:
// approved books whose spine has no outline on its shelf photo, and outlines on one photo
// that lie on top of each other (two books can't stand in the same place). The outlines
// feed the book page's "Where is it" and the lab's training data for spine finders.
// A hand-made outline is { poly, by: 'admin', at }; a book that can't be seen on its photo
// is { hidden: true, by: 'admin', at }, so scripts/spots.js does not look for it again.
import { one, many, q } from './db.js';
import { requireUser } from './auth.js';

const ADMIN = 3;
const OVERLAP = 0.5; // two outlines on one photo overlap when their boxes' IoU is above this

const TITLE = 'coalesce(gb.title, mb.title, b.title, i.title)';
const JOINS = `LEFT JOIN books b ON b.id = i.book_id
    LEFT JOIN sightings g ON g.id = i.sighting_id LEFT JOIN books gb ON gb.id = g.book_id
    LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books mb ON mb.id = m.book_id`;
const ITEM = `i.id, i.scan_id, i.frame_path, i.crop_path, i.spot, i.decision, coalesce(i.book_id, g.book_id, m.book_id) AS book_id, ${TITLE} AS title, s.created_at`;
const SHELF = `i.via = 'vision' AND i.frame_path IS NOT NULL AND s.source IN ('photo', 'video')`;

const box = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
export function boxIou(p1, p2) {
  const a = box(p1), b = box(p2);
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h, area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
}

// Groups of outlines on one photo that overlap (connected through any overlapping pair).
export function overlapGroups(items) {
  const byPhoto = new Map();
  for (const it of items) {
    const k = `${it.scan_id}|${it.frame_path}`;
    byPhoto.set(k, [...(byPhoto.get(k) ?? []), it]);
  }
  const groups = [];
  for (const list of byPhoto.values()) {
    const seen = new Set();
    for (const start of list) {
      if (seen.has(start)) continue;
      const group = [start];
      seen.add(start);
      for (let k = 0; k < group.length; k++) {
        for (const o of list) if (!seen.has(o) && boxIou(group[k].spot.poly, o.spot.poly) > OVERLAP) { seen.add(o); group.push(o); }
      }
      if (group.length > 1) groups.push(group);
    }
  }
  return groups;
}

// Four corners, each [x, y] as a fraction of the photo.
export function cleanPoly(poly) {
  if (!Array.isArray(poly) || poly.length !== 4) return null;
  const out = poly.map((p) => (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) ? p.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000) : null));
  if (out.includes(null)) return null;
  const [x1, y1, x2, y2] = box(out);
  return x2 - x1 > 0.002 && y2 - y1 > 0.002 ? out : null;
}

const view = (r) => ({
  id: r.id, title: r.title, book: r.book_id, scan: r.scan_id, photo: `/uploads/${r.frame_path}`,
  frame: r.frame_path.match(/-(\d+)[_.][^/]*$/)?.[1] ?? null, crop: r.crop_path ? `/uploads/${r.crop_path}` : null,
  poly: r.spot?.poly ?? null, hidden: !!r.spot?.hidden, byAdmin: r.spot?.by === 'admin', at: r.created_at,
});

export default async function outlineRoutes(app) {
  app.get('/api/admin/outlines', { preHandler: requireUser(ADMIN) }, async () => {
    const missing = await many(
      `SELECT ${ITEM} FROM scan_items i JOIN scans s ON s.id = i.scan_id ${JOINS}
        WHERE ${SHELF} AND i.decision = 'approved' AND (i.spot IS NULL OR (i.spot->'poly' IS NULL AND i.spot->>'hidden' IS NULL))
        ORDER BY s.created_at, i.scan_id, i.frame_path, i.id`);
    const drawn = await many(
      `SELECT ${ITEM} FROM scan_items i JOIN scans s ON s.id = i.scan_id ${JOINS}
        WHERE ${SHELF} AND i.decision = 'approved' AND i.spot->'poly' IS NOT NULL
        ORDER BY s.created_at, i.scan_id, i.frame_path, i.id`);
    return { missing: missing.map(view), overlapping: overlapGroups(drawn).map((g) => g.map(view)) };
  });

  // One book's photo with every other outline on it.
  app.get('/api/admin/outlines/:id', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const it = await one(`SELECT ${ITEM} FROM scan_items i JOIN scans s ON s.id = i.scan_id ${JOINS} WHERE i.id = $1 AND ${SHELF}`, [Number(req.params.id) || 0]);
    if (!it) return reply.code(404).send({ error: 'not found' });
    const others = await many(
      `SELECT ${ITEM} FROM scan_items i JOIN scans s ON s.id = i.scan_id ${JOINS}
        WHERE i.scan_id = $1 AND i.frame_path = $2 AND i.id <> $3 AND coalesce(i.decision, '') NOT IN ('declined', 'merged', 'skipped')
        ORDER BY i.id`, [it.scan_id, it.frame_path, it.id]);
    return { item: view(it), others: others.map(view) };
  });

  app.post('/api/admin/outlines/:id', { preHandler: requireUser(ADMIN) }, async (req, reply) => {
    const id = Number(req.params.id) || 0;
    const at = new Date().toISOString();
    let spot;
    if (req.body?.hidden === true) spot = { hidden: true, by: 'admin', at };
    else {
      const poly = cleanPoly(req.body?.poly);
      if (!poly) return reply.code(400).send({ error: 'an outline needs four corners inside the photo' });
      spot = { poly, by: 'admin', at };
    }
    const r = await q(`UPDATE scan_items SET spot = $2 WHERE id = $1 AND frame_path IS NOT NULL`, [id, JSON.stringify(spot)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not found' });
    return { ok: true, spot };
  });
}
