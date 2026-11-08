// Outlines for spines scanned before 8 Nov 2026 (when the reading started keeping them):
// the vision model locates each kept book by its title on the photo the queue showed.
//   node --env-file=../.env scripts/spots.js [--limit N]
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { many, q, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { locateSpine } from '../src/vision.js';

const KEEP = resolve(process.env.SCAN_DIR || join(config.uploadDir, '..', 'scan-media'), '..', 'scan-keep');
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 1000;
const items = await many(`
  SELECT i.id, i.scan_id, i.frame_path, coalesce(gb.title, mb.title, b.title, i.title) AS title
    FROM scan_items i JOIN scans s ON s.id = i.scan_id
    LEFT JOIN books b ON b.id = i.book_id
    LEFT JOIN sightings g ON g.id = i.sighting_id LEFT JOIN books gb ON gb.id = g.book_id
    LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books mb ON mb.id = m.book_id
   WHERE i.spot IS NULL AND i.via = 'vision' AND i.frame_path IS NOT NULL AND s.source IN ('photo', 'video')
     AND coalesce(i.decision, '') NOT IN ('declined', 'merged', 'skipped')
   ORDER BY i.id DESC LIMIT $1`, [limit]);
let found = 0;
for (const i of items) {
  // The frame shown: scan-<id8>-<n>_….webp is photo/frame n; its full-size copy is scan-keep/<scan>/<n>.jpg.
  const n = i.frame_path.match(/scan-[0-9a-f]{8}-(\d+)_/)?.[1];
  const img = (n && await readFile(join(KEEP, i.scan_id, `${n}.jpg`)).catch(() => null)) ?? await readFile(join(config.uploadDir, i.frame_path)).catch(() => null);
  if (!img) continue;
  const spot = await locateSpine(img, i.title).catch(() => null);
  console.log(`${i.id} ${i.title}: ${spot ? JSON.stringify(spot.poly) : '-'}`);
  if (!spot) continue;
  found++;
  await q('UPDATE scan_items SET spot = $2 WHERE id = $1', [i.id, JSON.stringify(spot)]);
}
console.log(`${items.length} items, ${found} located`);
await pool.end();
