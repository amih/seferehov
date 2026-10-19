// Cover photos look sharper after Real-ESRGAN (the model used for upscaling video): it
// cleans phone-camera noise and blur, so the letters on the cover come out crisp. The
// photo is enlarged 4x on the GPU (~20 s), then brought back to the usual size. Runs
// after the cover text was read: the text always comes from the photo as taken, since
// the model may redraw tiny letters. The original stays on disk (photos.orig_path).
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

// One cover photo, newest first. Returns false when none is waiting.
export async function enhanceNext() {
  if (!config.enhanceBin) return false;
  const p = await one(
    `SELECT id, path, thumb_path FROM photos
      WHERE enhanced_at IS NULL AND ocr_at IS NOT NULL AND kind IN ('cover', 'back')
      ORDER BY created_at DESC LIMIT 1`);
  if (!p) return false;
  const tmp = join(tmpdir(), `seferehov-enh-${p.id}.png`);
  try {
    await realesrgan(join(config.uploadDir, p.path), tmp);
    const stamp = Date.now().toString(36);
    const rel = p.path.replace(/\.webp$/, `_e${stamp}.webp`);
    const thumbRel = p.thumb_path === p.path ? rel.replace(/\.webp$/, '_t.webp') : p.thumb_path.replace(/\.webp$/, `_e${stamp}.webp`);
    const info = await sharp(tmp).resize(1600, 1600, { fit: 'inside' }).webp({ quality: 85 }).toFile(join(config.uploadDir, rel));
    await sharp(tmp).resize(400, 400, { fit: 'inside' }).webp({ quality: 75 }).toFile(join(config.uploadDir, thumbRel));
    await q(`UPDATE photos SET orig_path = path, path = $2, thumb_path = $3, width = $4, height = $5, enhanced_at = now() WHERE id = $1`,
      [p.id, rel, thumbRel, info.width, info.height]);
    await q('UPDATE scan_items SET frame_path = $2 WHERE frame_path = $1', [p.path, rel]);
    await q('UPDATE scan_items SET back_path = $2 WHERE back_path = $1', [p.path, rel]);
  } catch (err) {
    // A missing file or a model failure: shown as taken, not tried again.
    await q('UPDATE photos SET enhanced_at = now() WHERE id = $1', [p.id]);
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return true;
}
