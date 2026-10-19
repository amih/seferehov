// Pictures look sharper after Real-ESRGAN (the model used for upscaling video): it
// cleans phone-camera noise and blur, so the letters come out crisp. A picture is
// enlarged 4x on the GPU (~20 s for a cover), then brought back to a showing size.
// Cover photos are done after their text was read: the text always comes from the photo
// as taken, since the model may redraw tiny letters, and the original stays on disk
// (photos.orig_path). Then the spine cut-outs and shelf pictures of finished scans.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import sharp from 'sharp';
import { config } from './config.js';
import { one, q } from './db.js';

function realesrgan(input, output) {
  return new Promise((resolve, reject) => {
    const bin = config.enhanceBin;
    const p = spawn(bin, ['-i', input, '-o', output, '-n', 'realesrgan-x4plus', '-m', join(dirname(bin), 'models'), '-f', 'png'],
      { stdio: 'ignore', timeout: 300_000 });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`realesrgan exit ${code}`))));
  });
}

// Sharpens one picture in uploads/ into new files ("_e<stamp>"), sized to fit
// `size` (and `thumb` for a small copy). Returns the new paths.
async function enhanceFile(rel, size, thumb = null) {
  const tmp = join(tmpdir(), `seferehov-enh-${process.pid}-${Date.now()}.png`);
  try {
    await realesrgan(join(config.uploadDir, rel), tmp);
    const stamp = Date.now().toString(36);
    const out = rel.replace(/\.webp$/, `_e${stamp}.webp`);
    const info = await sharp(tmp).resize(size[0], size[1], { fit: 'inside' }).webp({ quality: 85 }).toFile(join(config.uploadDir, out));
    let thumbOut = null;
    if (thumb) {
      thumbOut = thumb.rel === rel ? out.replace(/\.webp$/, '_t.webp') : thumb.rel.replace(/\.webp$/, `_e${stamp}.webp`);
      await sharp(tmp).resize(400, 400, { fit: 'inside' }).webp({ quality: 75 }).toFile(join(config.uploadDir, thumbOut));
    }
    return { path: out, thumb: thumbOut, width: info.width, height: info.height };
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const SHARPENED = `'_e[a-z0-9]+\\.webp$'`;

async function nextCover() {
  const p = await one(
    `SELECT id, path, thumb_path FROM photos
      WHERE enhanced_at IS NULL AND ocr_at IS NOT NULL AND kind IN ('cover', 'back')
      ORDER BY created_at DESC LIMIT 1`);
  if (!p) return false;
  // A cover taken from a scan's shelf picture that was sharpened already.
  if (new RegExp(SHARPENED.slice(1, -1)).test(p.path)) {
    await q('UPDATE photos SET enhanced_at = now() WHERE id = $1', [p.id]);
    return true;
  }
  try {
    const e = await enhanceFile(p.path, [1600, 1600], { rel: p.thumb_path });
    await q(`UPDATE photos SET orig_path = path, path = $2, thumb_path = $3, width = $4, height = $5, enhanced_at = now() WHERE id = $1`,
      [p.id, e.path, e.thumb, e.width, e.height]);
    await q('UPDATE scan_items SET frame_path = $2 WHERE frame_path = $1', [p.path, e.path]);
    await q('UPDATE scan_items SET back_path = $2 WHERE back_path = $1', [p.path, e.path]);
  } catch (err) {
    // A missing file or a model failure: shown as taken, not tried again.
    await q('UPDATE photos SET enhanced_at = now() WHERE id = $1', [p.id]);
    throw err;
  }
  return true;
}

// Spine cut-outs first (small, so they gain the most), then whole shelf pictures.
async function nextScanPicture() {
  const r = await one(
    `SELECT x.rel, x.spine FROM (
       SELECT i.crop_path AS rel, true AS spine, s.created_at FROM scan_items i JOIN scans s ON s.id = i.scan_id
        WHERE s.status = 'done' AND i.crop_path IS NOT NULL
       UNION ALL
       SELECT i.frame_path, false, s.created_at FROM scan_items i JOIN scans s ON s.id = i.scan_id
        WHERE s.status = 'done' AND i.frame_path IS NOT NULL AND s.source <> 'cover') x
      WHERE x.rel !~ ${SHARPENED} AND NOT EXISTS (SELECT 1 FROM enhanced_files f WHERE f.orig = x.rel)
      ORDER BY x.spine DESC, x.created_at DESC LIMIT 1`);
  if (!r) return false;
  let e = null;
  try {
    e = await enhanceFile(r.rel, r.spine ? [1600, 400] : [1600, 1600]);
  } finally {
    await q('INSERT INTO enhanced_files(orig, path) VALUES ($1, $2) ON CONFLICT DO NOTHING', [r.rel, e?.path ?? null]);
  }
  await q('UPDATE scan_items SET crop_path = $2 WHERE crop_path = $1', [r.rel, e.path]);
  await q('UPDATE scan_items SET frame_path = $2 WHERE frame_path = $1', [r.rel, e.path]);
  await q('UPDATE photos SET orig_path = path, path = $2, thumb_path = $2, enhanced_at = now() WHERE path = $1', [r.rel, e.path]);
  return true;
}

// One picture. Returns false when none is waiting.
export async function enhanceNext() {
  if (!config.enhanceBin) return false;
  return await nextCover() || await nextScanPicture();
}
