// Hebrew books saved with romanized author names ("Menaḥem Miśgav", from Open Library):
// take the names from the National Library's record of the book (see hebrewAuthors).
//   node --env-file=../.env scripts/nli-hebrew-names.js
import { many, q, pool } from '../src/db.js';
import { hebrewAuthors } from '../src/books.js';

const rows = await many(`SELECT id, title, authors, isbn13, year FROM books
  WHERE title ~ '[א-ת]' AND cardinality(authors) > 0 AND NOT (array_to_string(authors, ' ') ~ '^[^a-zA-Zḥśṿḳṭẓʻʼ]*$')`);
let heb = 0;
for (const r of rows) {
  const authors = await hebrewAuthors(r);
  if (authors.join('\t') === r.authors.join('\t')) continue;
  await q('UPDATE books SET authors = $2 WHERE id = $1', [r.id, authors]);
  if (authors.some((a) => /[א-ת]/.test(a))) heb++;
  console.log(`${r.id} ${r.title}: ${r.authors.join('; ')} → ${authors.join('; ')}`);
}
console.log(`${rows.length} books checked, ${heb} now with Hebrew names`);
await pool.end();
