// Fills scan_items.crop_shape for cut-outs saved before it was recorded, from the saved
// picture (same proportions as the cut; blank share close to the original's).
//   node --env-file=../.env scripts/crop-shapes.js
import { join } from 'node:path';
import { many, q, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { cropShape } from '../src/scans.js';

const rows = await many('SELECT id, crop_path FROM scan_items WHERE crop_path IS NOT NULL AND crop_shape IS NULL');
let n = 0;
for (const r of rows) {
  const shape = await cropShape(join(config.uploadDir, r.crop_path)).catch(() => null);
  if (shape) { await q('UPDATE scan_items SET crop_shape = $2 WHERE id = $1', [r.id, JSON.stringify(shape)]); n++; }
}
console.log(`${n} of ${rows.length} cut-outs measured`);
await pool.end();
