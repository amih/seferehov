// A photo of a book's cover: find the cover's four corners, then cut it out and
// straighten it (perspective correction), so the background, the hand holding it and
// the tilt are gone and the cover fills the picture. The vision model says roughly
// where the corners are; OpenCV (WebAssembly) snaps them to the cover's edges and warps.
// Returns the new JPEG, or null when no cover shape was found with confidence.
import sharp from 'sharp';
import { coverCorners } from './vision.js';
import { step } from './trace.js';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { config } from './config.js';
import { one, q } from './db.js';

// Cover photos are saved as taken, then cropped here one at a time in the background
// (the vision model takes ~10 s): new files (the old URLs stay cached for a month),
// and every row that pointed at the old files moves to the new ones.
const jobs = [];
let running = false;
export function cropPhotoLater(photoId, buffer, log = console) {
  jobs.push({ photoId, buffer });
  if (running) return;
  running = true;
  (async () => {
    while (jobs.length) {
      const job = jobs.shift();
      try { await cropPhoto(job.photoId, job.buffer); } catch (err) { log.warn?.({ err, photo: job.photoId }, 'cover crop failed'); }
    }
    running = false;
  })();
}

export async function cropPhoto(photoId, buffer = null) {
  const p = await one('SELECT * FROM photos WHERE id = $1', [photoId]);
  if (!p || p.cropped_at) return false;
  buffer ??= await sharp(join(config.uploadDir, p.path)).toBuffer();
  const out = await cropCover(buffer);
  if (!out) { await q('UPDATE photos SET cropped_at = now() WHERE id = $1', [photoId]); return false; }
  const stamp = Date.now().toString(36);
  const rel = p.path.replace(/(_c\w+)?\.webp$/, `_c${stamp}.webp`);
  const thumbRel = p.thumb_path === p.path ? rel.replace(/\.webp$/, '_t.webp') : p.thumb_path.replace(/(_c\w+)?\.webp$/, `_c${stamp}.webp`);
  const info = await sharp(out).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(join(config.uploadDir, rel));
  await sharp(out).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(join(config.uploadDir, thumbRel));
  await q('UPDATE photos SET path = $2, thumb_path = $3, width = $4, height = $5, cropped_at = now() WHERE path = $1', [p.path, rel, thumbRel, info.width, info.height]);
  await q('UPDATE scan_items SET frame_path = $2 WHERE frame_path = $1', [p.path, rel]);
  await q('UPDATE scan_items SET back_path = $2 WHERE back_path = $1', [p.path, rel]);
  await unlink(join(config.uploadDir, p.path)).catch(() => {});
  if (p.thumb_path !== p.path) await unlink(join(config.uploadDir, p.thumb_path)).catch(() => {});
  return true;
}

// The module object is itself "thenable": it is handed over wrapped, or awaiting it
// would never end.
let cvPromise = null;
async function getCv() {
  cvPromise ??= import('@techstark/opencv-js').then(({ default: mod }) => new Promise((resolve) => {
    const done = () => { delete mod.then; resolve({ cv: mod }); };
    if (mod.Mat) done(); else mod.onRuntimeInitialized = done;
  }));
  return (await cvPromise).cv;
}

const WORK = 900; // detection runs on a copy this size (long side)

export async function cropCover(buffer) {
  const cv = await getCv();
  const meta = await sharp(buffer).rotate().metadata();
  const upright = await sharp(buffer).rotate().toBuffer();
  const { data, info } = await sharp(upright).resize(WORK, WORK, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const rough = await coverCorners(upright).catch(() => null);
  const report = (verdict, extra = {}, images = {}) => step('cover-crop', { note: 'the vision model points at the corners; an OpenCV outline close to them is more exact', verdict, W: w, H: h, ...extra }, { before: upright, ...images });
  if (!rough) { await report('no corners: photo used as it is'); return null; }
  const model = order(rough.map(([x, y]) => [x * w, y * h]));
  if (!quadScore(model, polyArea(model), w, h)) { await report('corners do not look like a book cover: photo used as it is', { model }); return null; }
  // An outline OpenCV found that agrees with the model's corners is more exact.
  const tol = 0.05 * Math.hypot(w, h);
  const near = findQuads(cv, data, w, h)
    .map((q) => ({ q, d: q.reduce((sum, p, i) => sum + dist(p, model[i]), 0) }))
    .filter(({ q }) => q.every((p, i) => dist(p, model[i]) < tol))
    .sort((a, b) => a.d - b.d);
  const quad = near[0]?.q ?? model;
  if (polyArea(quad) > 0.93 * w * h) { await report('cover already fills the photo', { model, quad }); return null; } // already fills the picture
  // Back to full size.
  const W = meta.orientation >= 5 ? meta.height : meta.width;
  const s = W / info.width;
  const out = await warp(cv, upright, quad.map(([x, y]) => [x * s, y * s]));
  await report(`cut out and straightened (${near[0] ? 'OpenCV outline' : "model's corners"})`, { model, quad }, { after: out });
  return out;
}

// Every four-cornered, book-like outline OpenCV sees.
function findQuads(cv, data, w, h) {
  const mats = [];
  const keep = (m) => { mats.push(m); return m; };
  try {
    const src = keep(cv.matFromImageData({ data, width: w, height: h }));
    const gray = keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const total = w * h;
    // Two ways to see the cover's outline: edges (Canny), and brightness/colour areas
    // (Otsu threshold both ways). The first good four-cornered shape wins.
    const masks = [];
    const edges = keep(new cv.Mat());
    cv.Canny(gray, edges, 30, 100);
    cv.dilate(edges, edges, cv.Mat.ones(5, 5, cv.CV_8U), new cv.Point(-1, -1), 2);
    masks.push(edges);
    for (const inv of [false, true]) {
      const t = keep(new cv.Mat());
      cv.threshold(gray, t, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
      cv.morphologyEx(t, t, cv.MORPH_OPEN, cv.Mat.ones(9, 9, cv.CV_8U));
      masks.push(t);
    }
    const found = [];
    for (const mask of masks) {
      const contours = keep(new cv.MatVector()), hier = keep(new cv.Mat());
      cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area < total * 0.1 || area > total * 0.99) { c.delete(); continue; }
        const quad = fourCorners(cv, c);
        c.delete();
        if (!quad) continue;
        if (quadScore(quad, area, w, h)) found.push(quad);
      }
    }
    return found;
  } finally {
    for (const m of mats) m.delete();
  }
}

// The contour simplified to four corners: polygon approximation, or else the convex
// hull's rotated bounding box when a hand or a shadow bends one edge.
function fourCorners(cv, contour) {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull);
  const peri = cv.arcLength(hull, true);
  try {
    for (const eps of [0.02, 0.03, 0.04, 0.06]) {
      const poly = new cv.Mat();
      cv.approxPolyDP(hull, poly, eps * peri, true);
      if (poly.rows === 4) {
        const pts = [];
        for (let i = 0; i < 4; i++) pts.push([poly.data32S[i * 2], poly.data32S[i * 2 + 1]]);
        poly.delete();
        return order(pts);
      }
      poly.delete();
    }
    const r = cv.minAreaRect(hull);
    return order(cv.RotatedRect.points(r).map((p) => [p.x, p.y]));
  } finally {
    hull.delete();
  }
}

// Corners as top-left, top-right, bottom-right, bottom-left.
function order(pts) {
  const bySum = [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polyArea = (q) => Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % q.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;

// Book-like: a large convex shape with roughly parallel opposite sides, a cover's
// proportions, mostly inside the picture, and filled by the contour (not a stray hull).
function quadScore(q, area, w, h) {
  const [tl, tr, br, bl] = q;
  const top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br);
  if (Math.min(top, bottom, left, right) < 40) return 0;
  if (Math.max(top, bottom) / Math.min(top, bottom) > 1.6 || Math.max(left, right) / Math.min(left, right) > 1.6) return 0;
  const ratio = (top + bottom) / (left + right);
  if (ratio < 0.45 || ratio > 1.15) return 0; // covers are portrait (or near square)
  const quadArea = polyArea(q);
  if (quadArea < 0.1 * w * h) return 0;
  const fill = area / quadArea;
  if (fill < 0.75) return 0;
  const outside = q.filter(([x, y]) => x < -w * 0.03 || y < -h * 0.03 || x > w * 1.03 || y > h * 1.03).length;
  if (outside) return 0;
  return (quadArea / (w * h)) * fill;
}

async function warp(cv, upright, quad) {
  const { data, info } = await sharp(upright).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [tl, tr, br, bl] = quad;
  const outW = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const outH = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  const src = cv.matFromImageData({ data, width: info.width, height: info.height });
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return await sharp(Buffer.from(dst.data), { raw: { width: outW, height: outH, channels: 4 } })
      .removeAlpha().normalize({ lower: 1, upper: 99 }).jpeg({ quality: 92 }).toBuffer();
  } finally {
    for (const m of [src, dst, from, to, M]) m.delete();
  }
}
