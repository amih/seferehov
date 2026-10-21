// A fixed test set for the reading pipeline, so accuracy figures can be checked again
// after every change. Run on the server that has the database, the uploads, the vision
// model and Surya (in server/, with ../.env). The photos and labels stay in <dir>,
// outside the repo: cover art belongs to its publishers.
//
//   node --env-file=../.env scripts/eval.js export <dir>
//     cover photos and approved shelf cut-outs → <dir>/img + <dir>/items.json
//     (run again later to add new ones; labels already made are kept)
//   node --env-file=../.env scripts/eval.js label <dir> [port]
//     a page on 127.0.0.1:<port> (default 3879) to type the true text of each cover,
//     starting from the best reading so far; reach it with ssh -L 3879:127.0.0.1:3879
//   node --env-file=../.env scripts/eval.js run <dir> [--set cover|spine] [--engines a,b] [--limit n]
//     reads every item with each engine, prints the scores, keeps the details in
//     <dir>/results/<time>.json
//
// Cover engines: vlm (the vision model transcribing), tesseract, surya, surya+hspell
// (what the app uses for Hebrew). Scores: words found (any order), words real (not
// invented), word and character accuracy (in order), title found. Spine engines: vlm
// (one read of the cut-out), pipeline (readCrop: vision model and Surya agreeing).
// Spine cut-outs were made by the pipeline itself, so that set measures reading, not
// finding the books on the shelf.
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { many, pool } from '../src/db.js';
import { fixHebrew } from '../src/hebfix.js';
import { generate, parseBooks, prepare, readCrop, suryaRead, tesseract, SPINE_PROMPT, TEXT_PROMPT } from '../src/vision.js';
import { charAccuracy, mean, median, titleFound, TITLE_HIT, wordAccuracy, wordsFound, wordsReal } from './eval-score.js';

const [cmd, dirArg, ...rest] = process.argv.slice(2);
if (!cmd || !dirArg) {
  console.error('usage: eval.js export|label|run <dir> …');
  process.exit(1);
}
const dir = resolve(dirArg);
const itemsFile = join(dir, 'items.json');
const load = async () => (existsSync(itemsFile) ? JSON.parse(await readFile(itemsFile, 'utf8')) : []);
const save = (items) => writeFile(itemsFile, `${JSON.stringify(items, null, 1)}\n`);
const hebrew = (s) => /[֐-׿]/.test(s ?? '');

async function exportSet() {
  await mkdir(join(dir, 'img'), { recursive: true });
  const items = await load();
  const known = new Set(items.map((x) => x.id));
  // Cover photos, with the book they belong to (a sighting, a home book or the queue item).
  const covers = await many(`
    SELECT p.id, p.kind, COALESCE(p.orig_path, p.path) AS path, p.ocr_text, p.ocr_status, b.title, b.authors
      FROM photos p
      LEFT JOIN LATERAL (
        SELECT book_id FROM sightings WHERE p.id IN (photo_id, back_photo_id) AND book_id IS NOT NULL
        UNION ALL SELECT book_id FROM my_books WHERE p.id IN (photo_id, back_photo_id)
        UNION ALL SELECT book_id FROM scan_items WHERE p.path IN (crop_path, back_path) AND book_id IS NOT NULL
        LIMIT 1) l ON true
      LEFT JOIN books b ON b.id = l.book_id
     WHERE p.kind IN ('cover', 'back')
     ORDER BY p.created_at`);
  // Spine cut-outs a reader approved: the book's title is the checked answer.
  const spines = await many(`
    SELECT i.id, i.crop_path AS path, i.title AS read, b.title, b.authors, i.outcome
      FROM scan_items i JOIN books b ON b.id = i.book_id
     WHERE i.decision = 'approved' AND i.via = 'vision' AND i.crop_path IS NOT NULL
     ORDER BY i.created_at`);
  let added = 0;
  const take = async (id, src, item) => {
    if (known.has(id)) return;
    const from = join(config.uploadDir, src);
    if (!existsSync(from)) return;
    const file = `img/${id}${extname(src)}`;
    await copyFile(from, join(dir, file));
    items.push({ id, file, ...item });
    added++;
  };
  for (const c of covers) {
    await take(`c-${c.id}`, c.path, {
      set: 'cover', kind: c.kind, title: c.title ?? null, authors: c.authors ?? null,
      // The best reading so far (an admin may already have corrected it): a start for labeling.
      draft: c.ocr_text ?? '', draft_status: c.ocr_status ?? null, truth: null, status: 'todo',
    });
  }
  for (const s of spines) {
    await take(`s-${s.id}`, s.path, { set: 'spine', title: s.title, authors: s.authors ?? null, app_read: s.read, outcome: s.outcome, status: 'done' });
  }
  await save(items);
  const n = (f) => items.filter(f).length;
  console.log(`${added} added · covers ${n((x) => x.set === 'cover')} (${n((x) => x.set === 'cover' && x.status === 'done')} labeled) · spines ${n((x) => x.set === 'spine')}`);
}

const PAGE = (item, left) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Label ${left} left</title>
<style>body{font:16px system-ui;margin:0;display:grid;grid-template-columns:1fr 1fr;height:100vh}
img{max-width:100%;max-height:100vh;object-fit:contain;background:#222}
form{display:flex;flex-direction:column;padding:12px;gap:8px}textarea{flex:1;font:18px/1.5 system-ui}
.row{display:flex;gap:8px}button{font-size:16px;padding:8px 16px}
@media(max-width:800px){body{grid-template-columns:1fr;height:auto}textarea{min-height:60vh}}</style>
<a href="/img/${item.file.slice(4)}" target="_blank"><img src="/img/${item.file.slice(4)}"></a>
<form method="post" action="/save/${item.id}">
<div><b>${item.kind === 'back' ? 'Back' : 'Front'} cover</b> · ${esc(item.title ?? '?')} · ${left} left</div>
<div>Type every word printed, as printed (skip the barcode). Order does not matter much.</div>
<textarea name="truth" dir="auto">${esc(item.truth ?? item.draft)}</textarea>
<div class="row"><button name="do" value="save">✓ Save</button><button name="do" value="skip">Skip (unreadable / not a cover)</button></div>
</form>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function label() {
  const port = Number(rest[0] || 3879);
  createServer(async (req, res) => {
    const items = await load();
    const todo = items.filter((x) => x.set === 'cover' && x.status === 'todo');
    if (req.url.startsWith('/img/')) {
      const f = join(dir, 'img', req.url.slice(5).replace(/[^\w.-]/g, ''));
      if (!existsSync(f)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'image/webp' }).end(await readFile(f));
    } else if (req.method === 'POST' && req.url.startsWith('/save/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const item = items.find((x) => x.id === req.url.slice(6));
      if (item) {
        item.status = form.get('do') === 'skip' ? 'skip' : 'done';
        item.truth = item.status === 'done' ? form.get('truth').replace(/\r\n/g, '\n').trim() : null;
        await save(items);
      }
      res.writeHead(303, { location: '/' }).end();
    } else if (todo.length) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(todo[0], todo.length));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<meta charset="utf-8"><p style="font:20px system-ui">All covers labeled. Run <code>eval.js run</code>.');
    }
  }).listen(port, '127.0.0.1', () => console.log(`label at http://127.0.0.1:${port}/`));
}

const COVER_ENGINES = {
  vlm: async (buf) => (await generate(await prepare(buf, 0, 1600), TEXT_PROMPT, 1200)).trim(),
  tesseract: (buf) => tesseract(buf),
  surya: async (buf) => (await suryaRead(buf)).text?.trim() ?? '',
};
const SPINE_ENGINES = {
  vlm: async (buf) => {
    const line = (await generate(await prepare(buf, 0), SPINE_PROMPT, 80)).trim();
    return /^NONE\b/i.test(line) ? '' : parseBooks(line.split('\n')[0])[0]?.title ?? '';
  },
  pipeline: async (buf) => {
    const { info } = await sharp(buf).rotate().toBuffer({ resolveWithObject: true });
    const r = await readCrop(buf, info.width, info.height);
    return r && r.verified !== false ? r.title : '';
  },
};

const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
const pct = (x) => (x == null ? '   —' : `${(x * 100).toFixed(0).padStart(3)}%`);

async function run() {
  const only = flag('--set');
  const engines = flag('--engines')?.split(',');
  const items = (await load()).filter((x) => x.status !== 'skip' && (!only || x.set === only)).slice(0, Number(flag('--limit') || 1e9));
  const rows = [];
  for (const [n, item] of items.entries()) {
    const buf = await readFile(join(dir, item.file));
    const list = item.set === 'cover' ? COVER_ENGINES : SPINE_ENGINES;
    const reads = {};
    for (const name of Object.keys(list).filter((e) => !engines || engines.includes(e) || (e === 'surya' && engines.includes('surya+hspell')))) {
      const t0 = Date.now();
      let text = '';
      let error;
      try { text = await list[name](buf); } catch (err) { error = err.message; }
      reads[name] = { text, ms: Date.now() - t0, error };
    }
    if (reads.surya) {
      const t0 = Date.now();
      reads['surya+hspell'] = { text: await fixHebrew(reads.surya.text), ms: reads.surya.ms + Date.now() - t0 };
    }
    for (const [engine, r] of Object.entries(reads)) {
      if (engines && !engines.includes(engine)) continue;
      const truth = item.status === 'done' && item.set === 'cover' ? item.truth : null;
      rows.push({
        id: item.id, set: item.set, kind: item.kind ?? 'spine', hebrew: hebrew(item.truth ?? item.title), engine, ms: r.ms,
        found: truth ? wordsFound(truth, r.text) : null, real: truth ? wordsReal(truth, r.text) : null,
        wacc: truth ? wordAccuracy(truth, r.text) : null, cacc: truth ? charAccuracy(truth, r.text) : null,
        // The title is printed on the front and on spines, not on most back covers.
        title: item.title && item.kind !== 'back' ? titleFound(item.title, r.text) : null,
        text: r.text, error: r.error,
      });
    }
    process.stderr.write(`\r${n + 1}/${items.length}`);
  }
  process.stderr.write('\n');
  await mkdir(join(dir, 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(dir, 'results', `${stamp}.json`), `${JSON.stringify({ at: new Date().toISOString(), model: config.vision.model, rows }, null, 1)}\n`);

  // One line per set × language × engine.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.set.padEnd(5)} ${(r.hebrew ? 'he' : 'other').padEnd(5)} ${r.engine}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log('set   lang  engine         items labeled  found   real  w-acc  c-acc  title  title≥80%  median s');
  for (const [key, g] of [...groups].sort()) {
    const labeled = g.filter((r) => r.found != null);
    const titled = g.filter((r) => r.title != null);
    console.log(`${key.padEnd(27)} ${String(g.length).padStart(5)} ${String(labeled.length).padStart(7)}  ${pct(mean(labeled.map((r) => r.found)))}  ${pct(mean(labeled.map((r) => r.real)))}  ${pct(mean(labeled.map((r) => r.wacc)))}  ${pct(mean(labeled.map((r) => r.cacc)))}  ${pct(mean(titled.map((r) => r.title)))}  ${pct(titled.length ? titled.filter((r) => r.title >= TITLE_HIT).length / titled.length : null)}      ${(median(g.map((r) => r.ms)) / 1000).toFixed(1).padStart(5)}`);
  }
  console.log(`details: ${join(dir, 'results', `${stamp}.json`)} · model ${config.vision.model} · API cost $0 (all local)`);
}

try {
  if (cmd === 'export') await exportSet();
  else if (cmd === 'label') { await label(); } else if (cmd === 'run') await run();
  else throw new Error(`unknown command ${cmd}`);
} finally {
  if (cmd !== 'label') await pool.end();
}
