// "Where is this book?": every shelf photo a book was seen in, with its spine outlined
// and the books next to it, so it can be found again at home (many rooms, many shelves)
// or on a street library's shelf. Home scans are shown only to the reader who took them;
// a street library's photos to anyone, once the books were approved.
import { one, many, q } from './db.js';
import { currentUser, requireUser } from './auth.js';

const center = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
const extent = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
};
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)) / Math.max(1e-6, Math.min(a2 - a1, b2 - b1));

// The books beside one spine on the same photo: on its shelf row (standing books, side by
// side) or in its pile (books lying flat, one on another). Up to 2 each way, nearest first.
export function neighboursOf(me, others) {
  const e = extent(me.poly);
  const standing = e.y2 - e.y1 >= e.x2 - e.x1;
  const [cx, cy] = center(me.poly);
  const same = others.filter((o) => {
    const f = extent(o.poly);
    return standing ? overlap(e.y1, e.y2, f.y1, f.y2) >= 0.3 : overlap(e.x1, e.x2, f.x1, f.x2) >= 0.3;
  }).map((o) => ({ ...o, d: standing ? center(o.poly)[0] - cx : center(o.poly)[1] - cy }));
  const side = (sign) => same.filter((o) => Math.sign(o.d) === sign).sort((a, b) => Math.abs(a.d) - Math.abs(b.d)).slice(0, 2).map(({ title }) => title);
  return standing ? { axis: 'row', left: side(-1), right: side(1) } : { axis: 'pile', above: side(-1), below: side(1) };
}

const SEEN_SQL = `
  SELECT i.id, i.scan_id, i.frame_path, i.crop_path, i.spot, s.created_at, s.label, s.user_id, s.location_id, s.owner,
         l.name AS location_name, l.code AS location_code
    FROM scan_items i JOIN scans s ON s.id = i.scan_id
    LEFT JOIN sightings g ON g.id = i.sighting_id
    LEFT JOIN my_books m ON m.id = i.my_book_id
    LEFT JOIN locations l ON l.id = s.location_id
   WHERE (i.book_id = $1 OR g.book_id = $1 OR m.book_id = $1)
     AND i.frame_path IS NOT NULL AND i.via = 'vision' AND s.source IN ('photo', 'video')
     AND coalesce(i.decision, '') NOT IN ('declined', 'merged', 'skipped')
     AND (s.user_id = $2 OR (s.location_id IS NOT NULL AND s.owner IS NULL AND i.decision = 'approved'))
   ORDER BY s.created_at DESC LIMIT 10`;

const SIBLINGS_SQL = `
  SELECT i.id, coalesce(gb.title, mb.title, b.title, i.title) AS title, i.spot
    FROM scan_items i
    LEFT JOIN books b ON b.id = i.book_id
    LEFT JOIN sightings g ON g.id = i.sighting_id LEFT JOIN books gb ON gb.id = g.book_id
    LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books mb ON mb.id = m.book_id
   WHERE i.scan_id = $1 AND i.frame_path = $2 AND i.id <> $3 AND i.spot IS NOT NULL
     AND coalesce(i.decision, '') NOT IN ('declined', 'merged', 'skipped')`;

export default async function whereRoutes(app) {
  app.get('/api/books/:id/where', async (req) => {
    const user = await currentUser(req).catch(() => null);
    const rows = await many(SEEN_SQL, [Number(req.params.id) || 0, user?.id ?? 0]);
    const out = [];
    for (const r of rows) {
      const sibs = r.spot ? (await many(SIBLINGS_SQL, [r.scan_id, r.frame_path, r.id])).filter((x) => x.spot?.poly) : [];
      out.push({
        item: r.id, scan: r.scan_id, at: r.created_at, mine: !!user && r.user_id === user.id,
        photo: `/uploads/${r.frame_path}`, crop: r.crop_path ? `/uploads/${r.crop_path}` : null,
        poly: r.spot?.poly ?? null, label: r.label ?? null,
        location: r.location_id && !r.owner ? { name: r.location_name, code: r.location_code } : null,
        neighbours: r.spot?.poly ? neighboursOf(r.spot, sibs) : null,
        // Everything else on the photo, outlined faintly.
        others: sibs.map((x) => ({ poly: x.spot.poly, title: x.title })),
      });
    }
    return { seen: out };
  });

  // The reader names the place a scan was taken; every book of that scan shows it.
  app.post('/api/scans/:id/label', { preHandler: requireUser() }, async (req, reply) => {
    const label = String(req.body?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    const s = await one('SELECT user_id FROM scans WHERE id = $1', [req.params.id]).catch(() => null);
    if (!s || s.user_id !== req.user.id) return reply.code(404).send({ error: 'not found' });
    await q('UPDATE scans SET label = $2 WHERE id = $1', [req.params.id, label]);
    return { label };
  });
}
