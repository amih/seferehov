// Books saved with a Hebrew title and a romanized subtitle (Open Library records:
// "מה לאכול: ekh li-veḥor mazon…"): take the National Library's Hebrew title, or the main
// title alone. node --env-file=../.env scripts/hebrew-titles.js [--apply]
import { many, q, pool } from '../src/db.js';
import { hebrewTitleAuthors, romanizedTail } from '../src/books.js';

const apply = process.argv.includes('--apply');
const rows = (await many(`SELECT id, title, authors, isbn13 FROM books WHERE title ~ '[א-ת]' AND title ~ '[A-Za-z]{2}' ORDER BY id`))
  .filter((b) => romanizedTail(b.title));
for (const b of rows) {
  const { title } = await hebrewTitleAuthors(b);
  console.log(`${b.id} ${b.title}\n    → ${title}`);
  if (apply && title !== b.title) await q('UPDATE books SET title = $2 WHERE id = $1', [b.id, title]);
}
console.log(`${rows.length} books${apply ? ' fixed' : ''}`);
await pool.end();
