// Hebrew books saved with romanized author names ("Menaḥem Miśgav", from Open Library):
// take the names from the National Library's record of the book (see hebrewAuthors).
// Starts from the names as Open Library has them, so it can be run again after a fix.
//   node --env-file=../.env scripts/nli-hebrew-names.js
import { many, q, pool } from '../src/db.js';
import { hebrewAuthors } from '../src/books.js';

const rows = await many(`SELECT b.id, b.title, b.authors, b.isbn13, b.year, o.authors AS ol_authors FROM books b
  LEFT JOIN ol_books o ON o.ol_key = b.source_ids->>'openlibrary'
  WHERE b.title ~ '[א-ת]' AND (o.authors IS NOT NULL OR array_to_string(b.authors, ' ') ~ '[a-zA-Z]')`);
let heb = 0; let changed = 0;
for (const r of rows) {
  const from = r.ol_authors?.length ? r.ol_authors : r.authors;
  if (!from.length || from.every((a) => /[א-ת]/.test(a))) continue;
  const authors = await hebrewAuthors({ ...r, authors: from });
  if (authors.some((a) => /[א-ת]/.test(a))) heb++;
  if (authors.join('\t') === r.authors.join('\t')) continue;
  await q('UPDATE books SET authors = $2 WHERE id = $1', [r.id, authors]);
  changed++;
  console.log(`${r.id} ${r.title.slice(0, 40)}: ${r.authors.join('; ')} → ${authors.join('; ')}`);
}
console.log(`${rows.length} books checked, ${changed} changed, ${heb} with Hebrew names`);
await pool.end();
