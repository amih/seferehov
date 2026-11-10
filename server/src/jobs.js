// Work about all the data, done on a schedule by the server rather than in requests:
// requests (the menu's to-do count, the duplicates pages, the "help wanted" list) only read
// the stored results. Run at start and then every JOB_HOURS; one run at a time.
import { many, q, tx } from './db.js';
import { PAIRS_SQL, LOCATION_PAIRS_SQL } from './duplicates.js';
import { PRESENT_BOOKS_SQL } from './locations.js';

const JOB_HOURS = 24;

// Duplicate candidates: every book compared with every other (O(n²), 0.6 s at 430 books),
// and libraries readers added against their neighbours.
export async function refreshDupes() {
  const books = await many(PAIRS_SQL.replace(/LIMIT \d+/, 'LIMIT 500'));
  const libs = await many(LOCATION_PAIRS_SQL.replace(/LIMIT \d+/, 'LIMIT 500'));
  await tx(async (db) => {
    await db.query('DELETE FROM dupe_candidates');
    for (const p of books) await db.query(`INSERT INTO dupe_candidates(kind, a, b, why) VALUES ('book', $1, $2, $3) ON CONFLICT DO NOTHING`, [p.a, p.b, p.why]);
    for (const p of libs) await db.query(`INSERT INTO dupe_candidates(kind, a, b, metres) VALUES ('library', $1, $2, $3) ON CONFLICT DO NOTHING`, [p.a, p.b, p.metres]);
  });
  return { books: books.length, libraries: libs.length };
}

// Per library with books: how many need cover photos, and open spines no catalogue knew.
export async function refreshLibraryNeeds() {
  const libs = await many(`SELECT DISTINCT location_id AS id FROM sightings WHERE status = 'approved'`);
  let n = 0;
  for (const { id } of libs) {
    const books = await many(PRESENT_BOOKS_SQL, [id]);
    const spines = (await many(
      `SELECT count(*)::int AS n FROM scan_items i JOIN scans s ON s.id = i.scan_id
        WHERE s.location_id = $1 AND s.source IN ('photo', 'video') AND i.book_id IS NULL AND i.quality <> 'low'
          AND (i.decision IS NULL OR i.decision = 'later') AND i.created_at > now() - interval '60 days'`, [id]))[0].n;
    await q(`INSERT INTO library_needs(location_id, books, need_covers, open_spines, updated_at) VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (location_id) DO UPDATE SET books = $2, need_covers = $3, open_spines = $4, updated_at = now()`,
      [id, books.length, books.filter((b) => b.needs_covers).length, spines]);
    n++;
  }
  await q(`DELETE FROM library_needs WHERE updated_at < now() - interval '2 days'`);
  return n;
}

let running = null;
export function runJobs(log) {
  running ??= (async () => {
    const t = Date.now();
    const dupes = await refreshDupes().catch((err) => log.error({ err }, 'job: duplicates'));
    const libs = await refreshLibraryNeeds().catch((err) => log.error({ err }, 'job: library needs'));
    log.info({ ms: Date.now() - t, dupes, libs }, 'daily jobs done');
  })().finally(() => { running = null; });
  return running;
}

export function startJobs(log) {
  setTimeout(() => runJobs(log), 60_000).unref(); // a minute after start, out of the way of the restart
  setInterval(() => runJobs(log), JOB_HOURS * 3600_000).unref();
}
