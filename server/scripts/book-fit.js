// Book pages whose title is not found in what was read off the book's own photos (seo.js
// titleFits): they get noindex and stay out of the sitemap. Fix the book (or decline the
// sighting) and the page comes back by itself.
//   node --env-file=../.env scripts/book-fit.js          → the doubtful pages
//   node --env-file=../.env scripts/book-fit.js --all    → every page, ✓ or ✗
import { many, pool } from '../src/db.js';
import { BOOK_EVIDENCE_SQL, SITEMAP_BOOKS_SQL, titleFits, bookPath } from '../src/seo.js';
import { config } from '../src/config.js';

const all = process.argv.includes('--all');
const ids = (await many(`SELECT id FROM (${SITEMAP_BOOKS_SQL}) x ORDER BY id`)).map((r) => r.id);
const rows = await many(BOOK_EVIDENCE_SQL, [ids]);
let bad = 0;
for (const r of rows.sort((a, b) => a.id - b.id)) {
  const ok = titleFits(r.title, r.evidence, r.authors);
  if (!ok) bad++;
  if (all || !ok) console.log(`${ok ? '✓' : '✗'} ${r.id}\t${r.title.slice(0, 70)}\n\tread: ${(r.evidence || '(nothing)').replace(/\s+/g, ' ').slice(0, 160)}\n\t${config.baseUrl}${bookPath(r)}`);
}
console.log(`${bad} of ${rows.length} book pages doubtful (noindex, not in the sitemap)`);
await pool.end();
