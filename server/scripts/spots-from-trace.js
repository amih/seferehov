// Exact outlines for spines scanned before 8 Nov 2026, from the scan's trace: the cut-out the
// book was read from is in the trace (its box and lean, on the photo the trace calls "photo N"),
// so its outline is the same spotOf() the reading uses now. Replaces the outlines scripts/spots.js
// guessed by title (spot.how = 'located-rough'), which are sometimes on another book.
//   node --env-file=../.env scripts/spots-from-trace.js           # what it would change
//   node --env-file=../.env scripts/spots-from-trace.js --check   # recompute outlines the reading saved itself: how close?
//   node --env-file=../.env scripts/spots-from-trace.js --write
// Outlines drawn by the admin (spot.by = 'admin') are never touched.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { many, q, pool } from '../src/db.js';
import { TRACE_DIR } from '../src/trace.js';
import { spotOf } from '../src/vision.js';

const CHECK = process.argv.includes('--check'), WRITE = process.argv.includes('--write');
const items = await many(`
  SELECT i.id, i.scan_id, i.frame_path, i.trace_at, i.spot, i.title FROM scan_items i
   WHERE i.trace_at IS NOT NULL AND i.frame_path IS NOT NULL AND coalesce(i.spot->>'by', '') <> 'admin'
     AND ${CHECK ? `i.spot->'poly' IS NOT NULL AND i.spot->>'how' IS NULL` : `(i.spot IS NULL OR i.spot->>'how' = 'located-rough')`}
   ORDER BY i.scan_id, i.id`);

const traces = new Map();
const traceOf = async (scan) => {
  if (!traces.has(scan)) traces.set(scan, await readFile(join(TRACE_DIR, scan, 'trace.json'), 'utf8').then(JSON.parse, () => null));
  return traces.get(scan);
};
const same = (a, b) => a?.length === b.length && a.every((x, k) => x === b[k]);

// The outline from the trace, or why not.
async function fromTrace(it) {
  const at = it.trace_at;
  if (!Array.isArray(at) || at.length !== 2 || !/^photo \d+$/.test(at[0]) || !/^cut-out \d+$/.test(at[1])) return { why: `trace_at ${JSON.stringify(at)}` };
  // "photo N" is the scan's N-th photo: frame N-1 (scan-<id8>-<n>_….webp).
  const frame = Number(it.frame_path.match(/-(\d+)_[^/]*$/)?.[1]);
  if (frame !== Number(at[0].slice(6)) - 1) return { why: `${at[0]} is not frame ${frame}` };
  const t = await traceOf(it.scan_id);
  if (!t) return { why: 'no trace' };
  const cut = t.steps.find((s) => s.kind === 'cut-out' && same(s.path, at) && s.box);
  const det = t.steps.find((s) => s.kind === 'detect' && same(s.path, [at[0]]) && s.W);
  if (!cut || !det) return { why: cut ? 'no photo size' : 'no cut-out box' };
  return { poly: spotOf({ tilt: cut.tilt ?? 0, box: cut.box }, det.W, det.H).poly };
}

const centre = (p) => [0, 1].map((k) => p.reduce((a, c) => a + c[k], 0) / p.length);
let done = 0, moved = 0;
const why = {}, errs = [];
for (const it of items) {
  const r = await fromTrace(it);
  if (!r.poly) { why[r.why.replace(/\d+/g, 'N')] = (why[r.why.replace(/\d+/g, 'N')] ?? 0) + 1; continue; }
  done++;
  const old = it.spot?.poly;
  const d = old ? Math.hypot(...[0, 1].map((k) => centre(r.poly)[k] - centre(old)[k])) : null;
  if (CHECK) { errs.push(d); continue; }
  if (d == null || d > 0.03) moved++;
  console.log(`${it.id} ${it.title}: ${old ? `centre moves ${(d * 100).toFixed(1)}% of the photo` : 'new'}`);
  if (WRITE) await q(`UPDATE scan_items SET spot = $2 WHERE id = $1`, [it.id, JSON.stringify({ poly: r.poly, how: 'trace' })]);
}
if (CHECK) {
  errs.sort((a, b) => a - b);
  console.log(`${done} outlines recomputed; centre distance median ${((errs[errs.length >> 1] ?? 0) * 100).toFixed(2)}%, 90th ${((errs[Math.floor(errs.length * 0.9)] ?? 0) * 100).toFixed(2)}%, max ${((errs.at(-1) ?? 0) * 100).toFixed(2)}% of the photo`);
} else console.log(`${items.length} items: ${done} from the trace (${moved} moved or new)${WRITE ? ', saved' : ' (dry run: --write saves)'}`);
if (Object.keys(why).length) console.log('not from the trace:', why);
await pool.end();
