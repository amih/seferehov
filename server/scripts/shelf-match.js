// Tries shelfMatch (approvals.js) on past decisions: every spine read at a library with no
// catalogue match, against the books already on that shelf before its scan. Right = the reader
// approved that same book; wrong = another book, or declined. Nothing is changed.
//   node server/scripts/shelf-match.js
import { many, pool } from '../src/db.js';
import { shelfMatch, SHELF_MATCH } from '../src/approvals.js';
import { titleSimilarity } from '../src/vision.js';

const items = await many(`
  SELECT i.id, i.title, i.author, i.decision, si.book_id AS final, s.location_id, s.created_at
    FROM scan_items i JOIN scans s ON s.id = i.scan_id LEFT JOIN sightings si ON si.id = i.sighting_id
   WHERE s.location_id IS NOT NULL AND s.kind = 'seen' AND s.source IN ('photo', 'video')
     AND i.book_id IS NULL AND i.decision IN ('approved', 'declined')`);
const shelf = async (loc, before) => many(`
  SELECT DISTINCT b.id, b.title, b.authors FROM sightings x JOIN books b ON b.id = x.book_id
   WHERE x.location_id = $1 AND x.status = 'approved' AND x.kind = 'seen' AND x.created_at < $2`, [loc, before]);
let right = 0, wrong = 0, none = 0, couldHave = 0;
for (const it of items) {
  const present = await shelf(it.location_id, it.created_at);
  const onShelf = it.decision === 'approved' && present.some((b) => b.id === it.final);
  if (onShelf) couldHave++;
  const b = shelfMatch(it, present);
  if (!b) {
    none++;
    if (onShelf) {
      const t = present.find((x) => x.id === it.final);
      console.log(`missed  #${it.id}: "${it.title}" | ${it.author ?? '-'}  =  "${t.title}" | ${t.authors?.[0] ?? '-'}  (${titleSimilarity(it.title, t.title).toFixed(2)})`);
    }
  } else if (it.decision === 'approved' && b.id === it.final) { right++; console.log(`right   #${it.id}: "${it.title}" -> "${b.title}"`); }
  else { wrong++; console.log(`WRONG   #${it.id} (${it.decision}): "${it.title}" | ${it.author ?? '-'} -> "${b.title}" | ${b.authors?.[0] ?? '-'}`); }
}
console.log({ thresholds: SHELF_MATCH, unmatched: items.length, onShelfAlready: couldHave, right, wrong, noMatch: none });
await pool.end();
