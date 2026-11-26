// One-off (26 Nov 2026): books left waiting by the bug fixed in capture.js answerSituation (the place was
// answered after the reading, and auto-approval never ran). Runs autoApproveSure on every finished photo or
// video scan whose place is settled and that still has an undecided book at AUTO_APPROVE_AT or above.
// Usage (server/): node --env-file=../.env scripts/auto-approve-waiting.js [--dry]
import { many } from '../src/db.js';
import { config } from '../src/config.js';
import { autoApproveSure } from '../src/approvals.js';

const dry = process.argv.includes('--dry');
if (!config.autoApproveAt) { console.log('auto-approval is off'); process.exit(0); }
const scans = await many(
  `SELECT s.* FROM scans s WHERE s.status = 'done' AND s.situation IS NULL AND s.source IN ('photo', 'video')
      AND EXISTS (SELECT 1 FROM scan_items i WHERE i.scan_id = s.id AND i.decision IS NULL AND i.book_id IS NOT NULL
                  AND i.confidence >= $1)`, [config.autoApproveAt]);
let n = 0;
for (const s of scans) {
  const c = dry ? (await many(`SELECT 1 FROM scan_items WHERE scan_id = $1 AND decision IS NULL AND book_id IS NOT NULL AND confidence >= $2`, [s.id, config.autoApproveAt])).length
    : await autoApproveSure(s);
  console.log(s.id, c); n += c;
}
console.log(dry ? 'would approve' : 'approved', n, 'books in', scans.length, 'scans');
process.exit(0);
