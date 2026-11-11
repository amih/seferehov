// Reads saved cover scans again with the current pipeline, saving nothing (dry), and prints
// what each would become: for testing changes to cover reading.
//   node --env-file=../.env scripts/cover-test.js <scan-id>...   (no ids: the covers readers edited or declined)
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { many, pool } from '../src/db.js';
import { processScan, MEDIA_DIR } from '../src/scans.js';
import { withTrace, TRACE_DIR } from '../src/trace.js';

const KEEP = resolve(join(MEDIA_DIR, '..', 'scan-keep'));
const ids = process.argv.slice(2);
const scans = ids.length ? await many(`SELECT s.*, i.title AS was FROM scans s LEFT JOIN scan_items i ON i.scan_id = s.id WHERE s.id = ANY($1)`, [ids])
  : await many(`SELECT s.*, i.title AS was, b.title AS final, b.authors AS final_authors FROM scans s JOIN scan_items i ON i.scan_id = s.id
      LEFT JOIN sightings g ON g.id = i.sighting_id LEFT JOIN my_books m ON m.id = i.my_book_id LEFT JOIN books b ON b.id = coalesce(g.book_id, m.book_id, i.book_id)
     WHERE s.source = 'cover' AND (i.outcome = 'edited' OR i.decision = 'declined') ORDER BY i.id`);
for (const s of scans) {
  const keep = join(KEEP, s.id);
  const files = (await readdir(keep).catch(() => [])).filter((f) => /^(0|1|extra-\d+)\.jpg$/.test(f));
  if (!files.length) { console.log(`${s.id}: no kept copies`); continue; }
  const id = crypto.randomUUID();
  await mkdir(join(MEDIA_DIR, id), { recursive: true });
  const media = [];
  for (const f of files.filter((f) => /^[01]\.jpg$/.test(f))) { await copyFile(join(keep, f), join(MEDIA_DIR, id, f.replace('.jpg', '.img'))); media.push({ path: f.replace('.jpg', '.img'), type: 'image' }); }
  const traceId = `cover-test-${id.slice(0, 8)}`;
  await withTrace(traceId, { flow: 'cover test', of: s.id }, () => processScan({ id, source: 'cover', media, book_code: s.book_code }, { dry: true })).catch((e) => console.log('error', e.message));
  await rm(join(MEDIA_DIR, id), { recursive: true, force: true });
  const t = JSON.parse(await readFile(join(TRACE_DIR, traceId, 'trace.json'), 'utf8').catch(() => '{"steps":[]}'));
  const steps = t.steps.filter((x) => ['cover-read', 'web-search', 'local-index', 'blurb-search', 'match', 'swap'].includes(x.kind));
  const m = steps.filter((x) => x.kind === 'match').at(-1);
  const r = steps.find((x) => x.kind === 'cover-read');
  console.log(`${s.id.slice(0, 8)} was "${s.was}"${s.final ? ` → reader: "${s.final}" / ${(s.final_authors ?? []).join(', ')}` : ''}
   read: ${r?.title} / ${r?.author}
   steps: ${steps.filter((x) => !['cover-read', 'match'].includes(x.kind)).map((x) => `${x.kind}: ${x.verdict ?? ''}`).join('; ')}
   now: ${m?.book ? `${m.book.title} / ${(m.book.authors ?? []).join(', ')}` : '(no book)'}  queue title: ${m?.queue_title}`);
}
await pool.end();
process.exit(0);
