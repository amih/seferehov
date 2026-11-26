// The fast spine reader (lab 065 A5; the admin approved it for the app on 26 Nov 2026). A small vision model
// (Qwen3-VL 2B with the lab's LoRA add-on, fastread/fast_read.py) reads every spine cut-out first; when the
// catalogue knows its Hebrew reading, the spine is settled and the big model (Qwen3-VL 8B) is not asked.
// Every other cut-out is read as before (vision.js readCrop). Lab 065, 198 real test spines: A5 settled 25% of
// them, 98% of those right, 25% fewer big-model calls, the cascade as right as the big model alone (92.4%).
//
// GPU: the card has room for one of the two models, so the small one reads all cut-outs of a scan's photos in
// one lease of the GPU queue (one model swap per scan, not per spine). Then the big model reads the rest.
// It settles a spine when the catalogue knows its reading (closeToRead). Every cut-out is logged (fast_reads, fast_read_batches) to check later that it really helps:
// server/scripts/fast-reads-report.js. A sample of settled spines (FAST_READER_SHADOW, 20%) is read by the big
// model anyway, and its reading kept, so the two can be compared on real scans.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { one } from './db.js';
import { step } from './trace.js';
import { catalogueKnows } from './books.js';
import { closeToRead } from './refindex.js';
import { cutPhoto, turnedCutout, parseBooks, MAX_CUTOUTS } from './vision.js';

const isHebrew = (s) => /[֐-׿]/.test(s ?? '');
// Photo buffer -> { scanId, frame, batchId, cut: [per cut-out state] }.
const states = new WeakMap();
export const fastFor = (buffer) => states.get(buffer) ?? null;

// The model's answer -> { title, author } or null (NONE, empty), as lab 065 parsed it.
function parse(text) {
  const line = String(text ?? '').trim().split('\n').find((l) => l.trim() && !/^\s*NONE\b/i.test(l)) ?? '';
  if (!line) return null;
  const b = parseBooks(line)[0] ?? { title: line.split('|')[0].trim(), author: line.split('|')[1]?.trim() || null };
  return b?.title ? { title: b.title, author: b.author ?? null, quality: b.quality } : null;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fast reader exit ${code}: ${err.split('\n').filter(Boolean).slice(-2).join(' / ')}`))));
  });
}

// Reads the pictures in one GPU lease. items: [{ id, jpeg }] -> { items: { id: { text, sec } }, batchId }.
async function readBatch(items, scanId) {
  const dir = await mkdtemp(join(tmpdir(), 'seferehov-fast-'));
  const t0 = Date.now();
  let out = null, error = null;
  try {
    const list = [];
    for (const [n, x] of items.entries()) { const file = join(dir, `${n}.jpg`); await writeFile(file, x.jpeg); list.push({ id: x.id, file }); }
    await writeFile(join(dir, 'in.json'), JSON.stringify({ items: list }));
    const [py, ...rest] = config.fastReader.split(/\s+/);
    const args = [...rest, join(dir, 'in.json'), join(dir, 'out.json')];
    if (config.enhanceLease) await run(config.enhanceLease, ['-c', config.fastReaderClient, '-l', `fast spine reader (${items.length} pictures)`, '--', py, ...args], 30 * 60_000);
    else await run(py, args, 30 * 60_000);
    out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
  } catch (err) {
    error = String(err.message ?? err).slice(0, 500);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const wall = Date.now() - t0;
  const batch = await one(`INSERT INTO fast_read_batches(scan_id, model, cutouts, wall_ms, load_s, read_s, error) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [scanId, out?.model ?? null, Math.round(items.length / 2), wall, out?.load_s ?? null, out ? Math.max(0, (out.total_s ?? 0) - (out.load_s ?? 0)) : null, error]).catch(() => null);
  await step('fast-read-batch', { note: error ? `the fast reader failed: ${error}; every cut-out is read the usual way`
    : `the fast reader (${out.model}) read ${items.length} pictures (${items.length / 2} cut-outs, both ways up) in ${(wall / 1000).toFixed(1)} s, ${out.load_s} s of it loading the model`,
  pictures: items.length, wall_ms: wall, load_s: out?.load_s ?? null, error });
  return { items: out?.items ?? {}, batchId: batch?.id ?? null, error };
}

// Before reading a scan (or one photo, for the bench): cut every photo, read all cut-outs with the fast reader in
// one GPU lease, and ask the catalogue about each reading. photos: [{ buffer, frame }].
// Latin readings settle too (FAST_READER_SCRIPTS=hebrew stops that): A5 reads Latin print badly (28.6% right), but
// in lab 065 the catalogue confirmed 18 of its Latin readings and all 18 were right (Hebrew: 31 of 32), so the
// catalogue check, not the script, is what keeps the wrong ones out.
export async function prepareFast(photos, { scanId = null } = {}) {
  if (!config.fastReader) return;
  const todo = [], fresh = [];
  for (const { buffer, frame } of photos) {
    if (states.has(buffer)) continue;
    const c = await cutPhoto(buffer);
    if (!c.cutRes?.spines?.length) continue;
    const state = { scanId, frame: frame ?? null, batchId: null, cut: [] };
    for (const [k, s] of c.cutRes.spines.slice(0, MAX_CUTOUTS).entries()) {
      const img = Buffer.from(s.jpeg, 'base64');
      const angles = s.h > s.w * 1.3 ? [270, 90] : [0, 180];
      const tries = [];
      for (const angle of angles) {
        const jpeg = await turnedCutout(img, angle);
        tries.push({ angle, jpeg });
        todo.push({ id: `${fresh.length}:${k}:${angle}`, jpeg, ref: tries.at(-1) });
      }
      state.cut.push({ k, tries });
    }
    states.set(buffer, state);
    fresh.push(state);
  }
  if (!todo.length) return;
  const { items, batchId, error } = await readBatch(todo, scanId);
  for (const x of todo) Object.assign(x.ref, items[x.id] ?? {});
  for (const state of fresh) {
    state.batchId = batchId;
    for (const f of state.cut) {
      f.texts = Object.fromEntries(f.tries.map((t) => [t.angle, t.text ?? null]));
      f.fast_s = f.tries.reduce((a, t) => a + (t.sec ?? 0), 0);
      if (error) continue;
      const t0 = Date.now();
      const reads = f.tries.map((t) => ({ ...t, read: parse(t.text) })).filter((t) => t.read);
      f.pick = reads.find((t) => isHebrew(t.read.title)) ?? reads[0] ?? null;
      const confirmed = [];
      for (const t of reads.filter((r) => config.fastScripts !== 'hebrew' || isHebrew(r.read.title))) {
        const close = (m) => closeToRead(t.read.title, m.title, m.authors);
        const m = await catalogueKnows(t.read.title, t.read.author, close).catch(() => null);
        if (m && close(m)) confirmed.push({ ...t, match: m });
      }
      // Both ways up confirmed as different books: not sure which, today's path decides.
      const books = new Set(confirmed.map((c) => c.match.title));
      if (confirmed.length && books.size === 1) {
        Object.assign(f, { pick: confirmed[0], settled: true, shadow: Math.random() < config.fastShadow });
      }
      f.gate_ms = Date.now() - t0;
    }
    const n = state.cut.length, settled = state.cut.filter((f) => f.settled).length;
    await step('fast-read', { note: `photo ${state.frame == null ? '' : state.frame + 1}: ${settled} of ${n} cut-outs settled by the fast reader (a reading the catalogue knows); the rest are read by the big model`,
      cutouts: state.cut.map((f) => ({ k: f.k, texts: f.texts, settled: !!f.settled, shadow: !!f.shadow, by: f.pick?.match?.by ?? null, catalogue: f.pick?.match?.title ?? null })) });
  }
}

// One row per cut-out; returns its id (null when it could not be written, e.g. the lab's read-only database).
export async function logFast(state, f, extra) {
  const p = f.pick;
  const row = await one(`INSERT INTO fast_reads(batch_id, scan_id, frame, cutout, texts, angle, title, author, hebrew, confirmed_by, cat_title, settled, shadow, used,
      ocr_ok, qwen_title, qwen_author, qwen_verified, qwen_calls, fast_s, gate_ms, qwen_ms)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
  [state.batchId, state.scanId, state.frame, f.k, JSON.stringify(f.texts ?? {}), p?.angle ?? null, p?.read?.title ?? null, p?.read?.author ?? null,
    p ? isHebrew(p.read.title) : null, p?.match?.by ?? null, p?.match?.title ?? null, !!f.settled, !!f.shadow, extra.used,
    extra.ocr_ok ?? null, extra.qwen?.title ?? null, extra.qwen?.author ?? null, extra.qwen ? extra.qwen.verified ?? null : null,
    extra.qwen_calls ?? null, f.fast_s ?? null, f.gate_ms ?? null, extra.qwen_ms ?? null]).catch(() => null);
  return row?.id ?? null;
}
