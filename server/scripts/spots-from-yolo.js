// Tighter spine outlines for books already on shelf photos, from the lab's best spine finder
// (lab experiment 028: YOLO11n-OBB trained on the admin's checked answer keys; 43/53 tight on
// the lab's test photos, against 33 for the reading's own boxes). The finder runs in the lab's
// Python (it has the weights and the GPU); this script hands it the photos and writes back.
//   node --env-file=../.env scripts/spots-from-yolo.js export <dir>     # photos + jobs.json for the finder
//   ~lab/venv/bin/python predict.py best.pt < <dir>/jobs.json > <dir>/pred.json
//   node --env-file=../.env scripts/spots-from-yolo.js apply <dir>/pred.json [--write]
// Each book keeps its own spine: its current outline picks the finder's rectangle that overlaps
// it most (each rectangle to one book, best overlaps first), and is replaced only when they
// overlap enough (IoU >= 0.45: below that the rectangle was often the next book) and the
// rectangle is at least 0.75 of the old outline's length (shorter ones covered only the middle
// of the spine, or straddled two). Measured on 16 Nov 2026's 343 candidates: 216 pass.
// The old outline is kept in spot.prev. Outlines drawn by the admin (spot.by = 'admin') are
// never touched; they are used to measure the finder instead. Writes <dir>/changes.json for
// the before/after pictures.
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { config } from '../src/config.js';
import { many, q, pool } from '../src/db.js';

const [cmd, arg] = process.argv.slice(2);
const WRITE = process.argv.includes('--write');
const MIN_IOU = 0.45, MIN_LENGTH = 0.75;

// Books on shelf photos that are shown (approved), with an outline or not.
const ITEMS_SQL = `
  SELECT i.id, i.frame_path, i.spot, i.title FROM scan_items i JOIN scans s ON s.id = i.scan_id
   WHERE i.frame_path IS NOT NULL AND i.decision = 'approved' AND s.source IN ('photo', 'video')
     AND coalesce(i.spot->>'hidden', '') <> 'true'
   ORDER BY i.frame_path, i.id`;

// ---- convex polygons (fractions of the photo; x scaled by the photo's width/height ratio)
const area = (p) => Math.abs(p.reduce((a, [x, y], k) => { const [x2, y2] = p[(k + 1) % p.length]; return a + x * y2 - x2 * y; }, 0)) / 2;
const ccw = (p) => (p.reduce((a, [x, y], k) => { const [x2, y2] = p[(k + 1) % p.length]; return a + x * y2 - x2 * y; }, 0) < 0 ? [...p].reverse() : p);
function clip(subject, clipper) { // Sutherland–Hodgman, both convex and counter-clockwise
  let out = subject;
  for (let k = 0; k < clipper.length && out.length; k++) {
    const [a, b] = [clipper[k], clipper[(k + 1) % clipper.length]];
    const inside = ([x, y]) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0;
    const cross = (p, r) => {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = [...p, ...r, ...a, ...b];
      const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const [p, r] = [input[i], input[(i + 1) % input.length]];
      if (inside(r)) { if (!inside(p)) out.push(cross(p, r)); out.push(r); } else if (inside(p)) out.push(cross(p, r));
    }
  }
  return out;
}
export function iou(a, b, aspect = 1) {
  const s = (p) => ccw(p.map(([x, y]) => [x * aspect, y]));
  const [A, B] = [s(a), s(b)];
  const i = clip(A, B); const inter = i.length > 2 ? area(i) : 0;
  return inter / (area(A) + area(B) - inter || 1);
}
// The long side of a quadrilateral, in the photo's proportions.
const length = (p, aspect) => Math.max(...[0, 1].map((k) => Math.hypot((p[k + 1][0] - p[k][0]) * aspect, p[k + 1][1] - p[k][1])));

if (cmd === 'export') {
  const dir = arg;
  await mkdir(join(dir, 'photos'), { recursive: true });
  const items = await many(ITEMS_SQL);
  const frames = [...new Set(items.map((i) => i.frame_path))];
  for (const f of frames) await copyFile(join(config.uploadDir, f), join(dir, 'photos', basename(f)));
  await writeFile(join(dir, 'jobs.json'), JSON.stringify(frames.map((f) => ({ key: f, path: join(dir, 'photos', basename(f)) }))));
  console.log(`${frames.length} photos, ${items.length} books`);
} else if (cmd === 'apply') {
  const pred = JSON.parse(await readFile(arg, 'utf8'));
  const items = await many(ITEMS_SQL);
  const byFrame = Map.groupBy(items, (i) => i.frame_path);
  const changes = [];
  const n = { books: 0, replaced: 0, kept_no_match: 0, no_outline: 0, admin: 0, frames: 0 };
  const adminCheck = [];
  for (const [frame, list] of byFrame) {
    const p = pred[frame]; if (!p) continue;
    n.frames++;
    const aspect = p.W / p.H;
    const boxes = p.boxes.map((b, k) => ({ ...b, k }));
    // Every (book, rectangle) pair with its overlap, best first; each used once.
    const pairs = [];
    for (const it of list) {
      n.books++;
      if (!it.spot?.poly) { n.no_outline++; continue; }
      for (const b of boxes) {
        const v = iou(it.spot.poly, b.poly, aspect);
        const long = length(b.poly, aspect) / length(it.spot.poly, aspect);
        if (v >= MIN_IOU && (long >= MIN_LENGTH || it.spot.by === 'admin')) pairs.push({ it, b, v });
      }
    }
    pairs.sort((x, y) => y.v - x.v);
    const usedI = new Set(), usedB = new Set();
    for (const { it, b, v } of pairs) {
      if (usedI.has(it.id) || usedB.has(b.k)) continue;
      usedI.add(it.id); usedB.add(b.k);
      if (it.spot.by === 'admin') { adminCheck.push(v); continue; }
      changes.push({ id: it.id, frame, title: it.title, how: it.spot.how ?? (it.spot.by ? `by:${it.spot.by}` : 'reading'), iou: Math.round(v * 100) / 100, old: it.spot.poly, poly: b.poly, conf: b.conf });
    }
    for (const it of list) if (it.spot?.poly && !usedI.has(it.id)) (it.spot.by === 'admin' ? adminCheck.push(0) : n.kept_no_match++);
    n.admin += list.filter((it) => it.spot?.by === 'admin').length;
  }
  n.replaced = changes.length;
  const byHow = Object.fromEntries(Object.entries(Object.groupBy(changes, (c) => c.how)).map(([k, v]) => [k, v.length]));
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  console.log({ ...n, replaced_by_kind: byHow, median_iou_old_new: med(changes.map((c) => c.iou)),
    admin_outlines_found: `${adminCheck.filter((v) => v >= 0.5).length}/${adminCheck.length} at IoU>=0.5 (median ${med(adminCheck)?.toFixed(2)})` });
  await writeFile(join(arg, '..', 'changes.json'), JSON.stringify({ n, changes, adminCheck, pred }));
  if (WRITE) {
    const at = new Date().toISOString();
    for (const c of changes) {
      await q(`UPDATE scan_items SET spot = jsonb_build_object('poly', $2::jsonb, 'by', 'yolo-028', 'conf', $3::numeric, 'at', $4::text, 'prev', spot)
                WHERE id = $1 AND coalesce(spot->>'by', '') <> 'admin'`, [c.id, JSON.stringify(c.poly), c.conf, at]);
    }
    console.log(`written: ${changes.length}`);
  }
} else {
  console.log('usage: spots-from-yolo.js export <dir> | apply <pred.json> [--write]');
}
await pool.end();
