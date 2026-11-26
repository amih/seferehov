// Does the fast spine reader (lab 065 A5, src/fastread.js) really help? From its log (fast_reads, fast_read_batches)
// and the readers' decisions on the items the cut-outs became.
// Usage (server/): node --env-file=../.env scripts/fast-reads-report.js [--days N] [--json]
//   settled      share of cut-outs the fast reader settled (a reading the catalogue knows)
//   shadow       settled cut-outs the big model read anyway: how often the two agree (the honest check of
//                "right among settled", since settled books are mostly approved automatically)
//   decisions    items read the fast way vs the usual way, at the same confidence: approved / declined by
//                hand, approved automatically, and automatic approvals undone later
//   cost         big-model calls and seconds saved per photo, against the fast reader's own time (GPU lease,
//                model load, reading, catalogue checks)
import { many, one } from '../src/db.js';
import { titleSimilarity } from '../src/vision.js';
import { closeToRead } from '../src/refindex.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const days = Number(arg('--days') ?? 3650);
const since = `now() - interval '${days} days'`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
const out = {};

const rows = await many(`SELECT f.*, i.decision, i.auto, i.confidence, i.confidence_why FROM fast_reads f LEFT JOIN scan_items i ON i.id = f.item_id
  WHERE f.created_at > ${since}`);
const batches = await one(`SELECT count(*)::int n, sum(cutouts)::int cutouts, avg(wall_ms)::int wall_ms, avg(load_s)::real load_s,
    sum(wall_ms)::bigint wall_total, count(*) FILTER (WHERE error IS NOT NULL)::int failed FROM fast_read_batches WHERE created_at > ${since}`);
if (!rows.length) { console.log('no fast reads logged yet'); process.exit(0); }

const n = rows.length;
const hebrew = rows.filter((r) => r.hebrew).length;
const settled = rows.filter((r) => r.settled);
const fast = rows.filter((r) => r.used === 'fast');
const shadow = rows.filter((r) => r.shadow && r.used === 'qwen');
out.cutouts = { all: n, hebrew_reading: hebrew, settled: settled.length, settled_share: settled.length / n, used_fast: fast.length, shadow: shadow.length,
  by_catalogue: { local: settled.filter((r) => r.confirmed_by === 'local').length, nli: settled.filter((r) => r.confirmed_by === 'nli').length } };
console.log(`Cut-outs read: ${n} (${batches.n} GPU batches, ${batches.failed} failed). A Hebrew reading: ${pct(hebrew, n)}.`);
console.log(`Settled: ${settled.length} = ${pct(settled.length, n)} (local catalogue ${out.cutouts.by_catalogue.local}, National Library ${out.cutouts.by_catalogue.nli}); kept the fast way ${fast.length}, shadow ${shadow.length}.`);

// Shadow: the big model's reading of the same settled cut-out.
const agree = (r) => r.qwen_title && (titleSimilarity(r.title, r.qwen_title) >= 0.8 || titleSimilarity(r.cat_title ?? '', r.qwen_title) >= 0.8
  || closeToRead(r.qwen_title, r.cat_title ?? r.title, []));
const sh = shadow.filter((r) => r.qwen_title || r.qwen_verified === false);
const shAgree = sh.filter(agree).length;
out.shadow = { compared: sh.length, agree: shAgree, big_model_nothing: shadow.filter((r) => !r.qwen_title).length };
console.log(`\nShadow check: the big model read ${sh.length} settled cut-outs too; same book ${shAgree} = ${pct(shAgree, sh.length)}; the big model read nothing on ${out.shadow.big_model_nothing}.`);
for (const r of sh.filter((x) => !agree(x)).slice(0, 15)) console.log(`  differ: fast "${r.title}" (catalogue "${r.cat_title}") vs big "${r.qwen_title}"  [scan ${r.scan_id?.slice(0, 8)} photo ${r.frame + 1} #${r.cutout + 1}]`);

// Decisions on the items, fast vs usual, by confidence band.
const band = (c) => (c == null ? 'none' : c >= 75 ? '75+' : c >= 45 ? '45-74' : '<45');
const groups = {};
for (const r of rows.filter((x) => x.item_id)) {
  const g = (groups[`${r.used} ${band(r.confidence)}`] ??= { items: new Set(), approved: 0, declined: 0, auto: 0, open: 0 });
  if (g.items.has(r.item_id)) continue;
  g.items.add(r.item_id);
  if (r.decision === 'approved') { g.approved++; if (r.auto) g.auto++; } else if (r.decision === 'declined') g.declined++; else g.open++;
}
console.log('\nItems (one per book in the queue)   approved (of them auto)  declined  open   approved among decided');
for (const [k, g] of Object.entries(groups).sort()) {
  console.log(`  ${k.padEnd(14)} ${String(g.items.size).padStart(6)}   ${String(g.approved).padStart(8)} (${g.auto})  ${String(g.declined).padStart(8)}  ${String(g.open).padStart(4)}   ${pct(g.approved, g.approved + g.declined)}`);
}
out.decisions = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { items: g.items.size, approved: g.approved, auto: g.auto, declined: g.declined, open: g.open }]));
// Automatic approvals undone: the decision moved away from approved later (scan_item_evidence keeps no undo trail,
// so an undone fast item shows as declined or open with auto still set).
const undone = rows.filter((r) => r.used === 'fast' && r.auto && r.decision !== 'approved').length;
console.log(`Fast items approved automatically and later undone: ${undone}.`);

// Cost: big-model calls and time.
const usual = rows.filter((r) => r.used === 'qwen' && r.qwen_ms != null);
const callsPer = usual.length ? usual.reduce((a, r) => a + (r.qwen_calls ?? 0), 0) / usual.length : 0;
const msPer = usual.length ? usual.reduce((a, r) => a + r.qwen_ms, 0) / usual.length : 0;
const photos = new Set(rows.map((r) => `${r.scan_id}:${r.frame}`)).size;
const savedCalls = fast.length * callsPer, savedS = fast.length * msPer / 1000;
const costS = Number(batches.wall_total ?? 0) / 1000 + rows.reduce((a, r) => a + (r.gate_ms ?? 0), 0) / 1000;
out.cost = { photos, qwen_calls_per_cutout: callsPer, qwen_s_per_cutout: msPer / 1000, saved_calls: savedCalls, saved_s: savedS, fast_cost_s: costS,
  batch_wall_s: (batches.wall_ms ?? 0) / 1000, batch_load_s: batches.load_s };
console.log(`\nCost over ${photos} photos: the usual path takes ${callsPer.toFixed(2)} big-model calls and ${(msPer / 1000).toFixed(1)} s per cut-out.`);
console.log(`Saved: ${savedCalls.toFixed(0)} big-model calls (${(savedCalls / photos).toFixed(1)} per photo), ${savedS.toFixed(0)} s (${(savedS / photos).toFixed(1)} s per photo).`);
console.log(`Spent: ${costS.toFixed(0)} s on the fast reader (${(costS / photos).toFixed(1)} s per photo; a batch ${(batches.wall_ms / 1000).toFixed(1)} s on average, ${batches.load_s?.toFixed(1)} s of it loading).`);
console.log(`Net: ${((savedS - costS) / photos).toFixed(1)} s per photo saved (the big model's reload after each batch shows in its first call's time, included above).`);
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
process.exit(0);
