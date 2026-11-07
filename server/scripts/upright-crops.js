// Turns the saved spine pictures of open queue items the right way up: before 7 Nov 2026
// a Latin-script spine read both ways up was kept the way Hebrew spines run, upside down.
// Tesseract (which reads upside-down print badly) decides, as readCrop now does.
//   node --env-file=../.env scripts/upright-crops.js [--apply]
import sharp from 'sharp';
import { join } from 'node:path';
import { many, q, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { tesseractWords, overlap } from '../src/vision.js';

const apply = process.argv.includes('--apply');
const items = await many(`SELECT id, title, author, crop_path FROM scan_items
  WHERE crop_path IS NOT NULL AND via = 'vision' AND (decision IS NULL OR decision = 'later') ORDER BY id`);
let n = 0;
for (const i of items) {
  const file = join(config.uploadDir, i.crop_path);
  const img = await sharp(file).jpeg().toBuffer().catch(() => null);
  if (!img) continue;
  const fit = [];
  for (const a of [0, 180]) {
    const t = await tesseractWords(await sharp(img).rotate(a).jpeg().toBuffer()).catch(() => '');
    fit.push(Math.max(overlap(i.title, t), 0.8 * overlap(i.author, t)));
  }
  if (fit[1] - fit[0] < 0.2) continue;
  n++;
  console.log(`${i.id} ${i.title}: ${fit.map((f) => f.toFixed(2)).join(' → ')}`);
  if (!apply) continue;
  // A new file name, so browsers do not show the cached upside-down one.
  const path = i.crop_path.replace(/(\.\w+)$/, `-up$1`);
  await sharp(file).rotate(180).toFile(join(config.uploadDir, path));
  await q('UPDATE scan_items SET crop_path = $2 WHERE id = $1', [i.id, path]);
}
console.log(`${items.length} pictures checked, ${n} ${apply ? 'turned' : 'upside down'}`);
await pool.end();
