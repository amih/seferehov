// Scores every shelf book the readers already decided on with the current confidence rules
// (src/confidence.js), from the evidence saved with it, and compares with what they decided.
// Nothing is changed.
//   node --env-file=../.env scripts/backtest-confidence.js           → table by confidence
//   node --env-file=../.env scripts/backtest-confidence.js --list    → plus every declined book
import { many, pool } from '../src/db.js';
import { join } from 'node:path';
import sharp from 'sharp';
import { confidenceOf } from '../src/confidence.js';
import { config } from '../src/config.js';

const list = process.argv.includes('--list');
const rows = await many(`
  SELECT i.id, i.title, i.author, i.via, i.quality, i.crop_path, i.decision, i.outcome, i.confidence AS old, i.confidence_why AS old_why,
         b.id AS book_id, b.title AS book_title, b.authors AS book_authors,
         (SELECT json_agg(json_build_object('stage', e.stage, 'source', e.source, 'outcome', e.outcome, 'detail', e.detail) ORDER BY e.id)
            FROM scan_item_evidence e WHERE e.item_id = i.id AND e.stage <> 'reader') AS evidence
    FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN books b ON b.id = i.book_id
   WHERE i.decision IN ('approved', 'declined') AND NOT i.auto AND s.source IN ('photo', 'video') AND i.confidence IS NOT NULL
   ORDER BY i.id`);

const table = new Map();
const declined = [];
for (const r of rows) {
  const evidence = r.evidence ?? [];
  const read = evidence.find((e) => e.stage === 'read');
  const item = { title: r.title, author: r.author, via: r.via, quality: r.quality, crop: r.crop_path, evidence,
    verified: read?.detail?.verified ?? (read?.source === 'vision+ocr' ? true : undefined) };
  // The cut-out's shape, from the saved picture (same proportions as the cut itself).
  const meta = r.crop_path ? await sharp(join(config.uploadDir, r.crop_path)).metadata().catch(() => null) : null;
  item.cropShape = meta ? { ratio: Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height) } : null;
  const book = r.book_id ? { id: r.book_id, title: r.book_title, authors: r.book_authors ?? [] } : null;
  const [c, why] = confidenceOf(item, book);
  const key = `${String(c).padStart(2)} ${why}`;
  const t = table.get(key) ?? { ok: 0, no: 0 };
  t[r.decision === 'approved' ? 'ok' : 'no']++;
  table.set(key, t);
  if (r.decision === 'declined' && (c >= 75 || r.old >= 75)) declined.push(`${r.id} ${c} ${why} (was ${r.old}) | ${r.title} / ${r.author ?? '-'} => ${book?.title ?? '-'} / ${book?.authors?.join(', ') || '-'}`);
}
console.log('confidence reason                   approved declined  agreement');
for (const [k, { ok, no }] of [...table].sort((a, b) => b[0].localeCompare(a[0]))) {
  console.log(`${k.padEnd(36)}${String(ok).padStart(8)}${String(no).padStart(9)}  ${Math.round((100 * ok) / (ok + no))}%`);
}
const tier = (min) => rows.length && [...table].filter(([k]) => Number(k.slice(0, 2)) >= min).reduce((a, [, v]) => ({ ok: a.ok + v.ok, no: a.no + v.no }), { ok: 0, no: 0 });
for (const min of [92, 90, 75]) {
  const { ok, no } = tier(min);
  console.log(`${min} and up: ${ok + no} books, ${ok} approved, ${no} declined, ${Math.round((100 * ok) / ((ok + no) || 1))}% agreement`);
}
if (list) console.log(`\nDeclined, scored 75 or more now or before:\n${declined.join('\n')}`);
await pool.end();
