// Runs the open queue items (and the ones set aside for later) read off spines through the
// current matching again: the title/author swap check, then the catalogue lookup (which no
// longer takes a book by another author). The reading itself is not redone.
//   node --env-file=../.env scripts/rematch.js          → what would change
//   node --env-file=../.env scripts/rematch.js --apply  → change it
import { many, q, pool } from '../src/db.js';
import { lookupTitle } from '../src/books.js';
import { swapIfReversed, localCheck } from '../src/refindex.js';

const apply = process.argv.includes('--apply');
const items = await many(`
  SELECT i.*, b.title AS book_title, b.authors AS book_authors,
         (SELECT row_to_json(e) FROM scan_item_evidence e WHERE e.item_id = i.id AND e.stage = 'read' ORDER BY e.id LIMIT 1) AS read
    FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN books b ON b.id = i.book_id
   WHERE (i.decision IS NULL OR i.decision = 'later') AND i.via = 'vision' AND s.source IN ('photo', 'video')
   ORDER BY i.id`);

let changed = 0;
for (const i of items) {
  // What was read off the spine (the item's author may be the catalogue's).
  let title = i.read?.after || i.title;
  // Items from before the reading was recorded: their author is the best there is.
  let author = i.read ? (i.read.detail?.author ?? null) : i.author;
  const ev = [];
  const sw = await swapIfReversed(title, author).catch(() => null);
  if (sw) {
    ev.push({ stage: 'correct', source: 'swap', outcome: 'corrected', before: `${title} | ${author}`, after: `${sw.title} | ${sw.author}`, detail: { name: sw.name, rematch: true } });
    [title, author] = [sw.title, sw.author];
  }
  let r = await lookupTitle(title, author, 'rematch').catch((err) => ({ error: err.message }));
  ev.push({ stage: 'verify', source: r.source ?? 'none', outcome: r.book ? 'match' : 'no_match', before: title, after: r.book?.title ?? null,
    detail: { rematch: true, book_id: r.book?.id ?? null, was_book_id: i.book_id ?? null } });
  // As in a scan: a reading no catalogue knows is corrected from the local title index
  // ("המילים סוד" → "סוד המילים"), then looked up again.
  if (!r.book) {
    const w = await localCheck(title, author).catch(() => null);
    const fixed = w?.match ? { title: w.match.title, author: w.match.author ?? author } : null;
    if (fixed) {
      ev.push({ stage: 'correct', source: `index:${w.match.source}`, outcome: 'corrected', before: `${title} | ${author ?? ''}`, after: `${fixed.title} | ${fixed.author ?? ''}`, detail: { rematch: true } });
      [title, author] = [fixed.title, fixed.author];
      r = await lookupTitle(title, author, 'rematch').catch((err) => ({ error: err.message }));
      ev.push({ stage: 'verify', source: r.source ?? 'none', outcome: r.book ? 'match' : 'no_match', before: title, after: r.book?.title ?? null,
        detail: { rematch: true, book_id: r.book?.id ?? null, was_book_id: i.book_id ?? null } });
    }
  }
  const book = r.book ?? null;
  const same = (book?.id ?? null) === (i.book_id ?? null) && !sw;
  const was = i.book_id ? `${i.book_title} / ${(i.book_authors ?? []).join(', ') || '-'}` : '(no book)';
  const now = book ? `${book.title} / ${(book.authors ?? []).join(', ') || '-'}` : '(no book)';
  console.log(`${same ? '  ' : '* '}${i.id} read "${title}" / ${author ?? '-'}${sw ? ' (swapped)' : ''}\n      was ${was}\n      now ${now}`);
  if (same) continue;
  changed++;
  if (!apply) continue;
  const confidence = book ? (sw ? 75 : 85) : (i.crop_path ? 40 : 25);
  const why = book ? (sw ? 'corrected_catalogue' : 'catalogue') : (i.crop_path ? 'ocr' : 'read');
  await q(`UPDATE scan_items SET title = $2, author = $3, book_id = $4, matched = $5, quality = $6, isbn13 = $7, confidence = $8, confidence_why = $9 WHERE id = $1`,
    [i.id, title, author ?? book?.authors?.[0] ?? null, book?.id ?? null, !!book, book ? 'high' : 'medium', book?.isbn13 ?? null, confidence, why]);
  for (const e of ev) {
    await q(`INSERT INTO scan_item_evidence(item_id, stage, source, outcome, before, after, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [i.id, e.stage, e.source, e.outcome, e.before ?? null, e.after ?? null, JSON.stringify(e.detail)]);
  }
}
console.log(`${items.length} open items, ${changed} ${apply ? 'changed' : 'would change'}`);
await pool.end();
