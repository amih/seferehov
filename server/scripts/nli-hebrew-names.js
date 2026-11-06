// Books saved from the National Library with romanized author names ("Menaḥem Miśgav"):
// re-read their catalogue record and keep the Hebrew names (MARC fields marked $9 heb).
//   node --env-file=../.env scripts/nli-hebrew-names.js
import { many, q, pool } from '../src/db.js';
import { nliRecords, bookFromMarc } from '../src/books.js';

const ROMAN = /[ḥśṿḳṭẓʻʼāēīōūḤŚṾḲṬẒ]/;
const rows = await many(`SELECT id, title, authors, source_ids->>'nli' AS mms FROM books
  WHERE source_ids ? 'nli' AND array_to_string(authors, ' ') ~ '[ḥśṿḳṭẓʻʼāēīōūḤŚṾḲṬẒ]'`);
let fixed = 0;
for (const r of rows) {
  const b = (await nliRecords(`alma.mms_id=${r.mms}`, 1)).map(bookFromMarc)[0];
  if (!b?.authors.length || b.authors.some((a) => ROMAN.test(a))) { console.log(`${r.id} ${r.title}: no Hebrew names in the record`); continue; }
  await q('UPDATE books SET authors = $2 WHERE id = $1', [r.id, b.authors]);
  console.log(`${r.id} ${r.title}: ${r.authors.join('; ')} → ${b.authors.join('; ')}`);
  fixed++;
}
console.log(`${fixed} of ${rows.length} books now have Hebrew author names`);
await pool.end();
