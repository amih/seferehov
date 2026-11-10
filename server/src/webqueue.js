// Web checks put off: when a scan is read and every search engine is resting or has had its
// share for the day, the check waits here and runs later, one at a time — every 3 minutes by
// day, every minute at night (00:00–07:00 Israel time), when the engines are quiet. A result
// updates the item still waiting in the reader's queue; a check still held is tried again
// half an hour later, up to 6 times.
import { one, q } from './db.js';
import { webCheck, blurbSearch, held } from './websearch.js';
import { titleByAuthor } from './coverfix.js';
import { lookupTitle } from './books.js';
import { authorsAgree } from './vision.js';

const DAY_GAP = 3 * 60_000, NIGHT_GAP = 60_000, RETRY_MS = 30 * 60_000, MAX_TRIES = 6;
const night = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }).format(new Date())) < 7;

// As src/confidence.js for a book the web queue found: the record must name the author read.
function webConfidence(book, fixed, how) {
  if (!book) return [55, how];
  const authors = (book.authors ?? []).filter(Boolean);
  if (!authors.length) return [60, 'catalogue_no_author'];
  if (fixed.author && !authorsAgree(authors, [fixed.author])) return [50, 'catalogue_other_author'];
  return [75, 'corrected_catalogue'];
}

export async function enqueueWeb(itemId, kind, steps, payload) {
  if (!steps.length) return;
  await q(`INSERT INTO web_jobs(item_id, kind, steps, payload, run_after) VALUES ($1, $2, $3, $4, now() + interval '20 minutes')
           ON CONFLICT (item_id) WHERE status = 'waiting' DO NOTHING`, [itemId, kind, steps, JSON.stringify(payload)]);
}

let busy = false, lastRun = 0, log = console;
export function startWebQueue(logger) {
  log = logger;
  setInterval(tick, 30_000).unref();
}

async function tick() {
  if (busy || Date.now() - lastRun < (night() ? NIGHT_GAP : DAY_GAP) || held()) return;
  busy = true;
  try {
    const job = await one(`UPDATE web_jobs SET attempts = attempts + 1 WHERE id = (
        SELECT id FROM web_jobs WHERE status = 'waiting' AND run_after <= now() ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
    if (!job) return;
    lastRun = Date.now();
    await run(job);
  } catch (err) {
    log.warn?.({ err }, 'web queue');
  } finally {
    busy = false;
  }
}

async function run(job) {
  const item = await one('SELECT * FROM scan_items WHERE id = $1', [job.item_id]);
  // Decided, or found meanwhile (a reader typed the title): nothing to do.
  if (!item || item.book_id || ['approved', 'declined', 'merged', 'skipped'].includes(item.decision)) {
    await q(`UPDATE web_jobs SET status = 'skipped', done_at = now() WHERE id = $1`, [job.id]);
    return;
  }
  const p = job.payload;
  const ev = [];
  let fixed = null, how = null, stillHeld = false;
  const before = [p.title, p.author].filter(Boolean).join(' | ');
  if (job.steps.includes('web') && p.title) {
    const w = await webCheck(p.title, p.author).catch((err) => ({ fixed: null, outcome: `error: ${err.message}`, tries: [] }));
    ev.push({ stage: 'correct', source: 'web', outcome: w.outcome, before, after: w.fixed ? [w.fixed.title, w.fixed.author].filter(Boolean).join(' | ') : null, detail: { queued: true, tries: w.tries } });
    if (w.outcome === 'held') stillHeld = true;
    if (w.fixed) [fixed, how] = [{ title: w.fixed.title, author: w.fixed.author ?? p.author }, 'web'];
  }
  if (!fixed && job.steps.includes('author') && p.author) {
    const A = await titleByAuthor(p.author, p.text ?? '').catch((err) => ({ pick: null, verdict: `error: ${err.message}` }));
    ev.push({ stage: 'correct', source: A.pick ? `author:${A.pick.source}` : 'author', outcome: A.pick ? 'corrected' : A.held ? 'held' : 'unknown', before,
      after: A.pick ? [A.pick.title, A.pick.author].join(' | ') : null, detail: { queued: true, verdict: A.verdict } });
    if (A.held) stillHeld = true;
    if (A.pick) [fixed, how] = [{ title: A.pick.title, author: A.pick.author }, 'author'];
  }
  if (!fixed && job.steps.includes('blurb') && p.blurb) {
    const B = await blurbSearch(p.blurb).catch((err) => ({ found: null, outcome: `error: ${err.message}`, tries: [] }));
    ev.push({ stage: 'correct', source: 'blurb', outcome: B.outcome, before, after: B.found ? [B.found.title, B.found.author].filter(Boolean).join(' | ') : null, detail: { queued: true, tries: B.tries } });
    if (B.outcome === 'held') stillHeld = true;
    if (B.found) [fixed, how] = [{ title: B.found.title, author: B.found.author ?? p.author }, 'blurb'];
  }
  let book = null;
  if (fixed) {
    // A cover's record must at least be by the author read (as when the scan was read).
    const verify = job.kind !== 'cover' || how === 'blurb' ? null
      : how === 'author' ? (c) => c.authors?.length > 0 && authorsAgree(c.authors, [p.author, fixed.author])
        : (c) => authorsAgree(c.authors, [p.author, fixed.author]);
    const r = await lookupTitle(fixed.title, fixed.author, 'webqueue', verify).catch(() => ({}));
    book = r.book ?? null;
    ev.push({ stage: 'verify', source: how, outcome: book ? 'match' : 'no_match', before: fixed.title, after: book?.title ?? null, detail: { queued: true, book_id: book?.id ?? null } });
    // Decided while this ran: leave the item as the reader has it.
    const now = await one('SELECT decision, book_id FROM scan_items WHERE id = $1', [item.id]);
    if (now && !now.book_id && !['approved', 'declined', 'merged', 'skipped'].includes(now.decision)) {
      await q(`UPDATE scan_items SET title = $2, author = $3, book_id = $4, matched = $5, quality = $6, isbn13 = coalesce($7, isbn13), confidence = $8, confidence_why = $9 WHERE id = $1`,
        [item.id, fixed.title, fixed.author ?? book?.authors?.[0] ?? item.author, book?.id ?? null, !!book, book ? 'high' : item.quality, book?.isbn13 ?? null,
          ...webConfidence(book, fixed, how)]);
    }
  }
  for (const e of ev) {
    await q(`INSERT INTO scan_item_evidence(item_id, stage, source, outcome, before, after, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [item.id, e.stage, e.source, e.outcome, e.before ?? null, e.after ?? null, JSON.stringify(e.detail ?? {})]).catch(() => {});
  }
  if (!fixed && stillHeld && job.attempts < MAX_TRIES) {
    await q(`UPDATE web_jobs SET run_after = now() + make_interval(secs => $2) WHERE id = $1`, [job.id, RETRY_MS / 1000]);
    return;
  }
  await q(`UPDATE web_jobs SET status = 'done', done_at = now(), result = $2 WHERE id = $1`,
    [job.id, book ? `book ${book.id}` : fixed ? `corrected: ${fixed.title}` : stillHeld ? 'still held: gave up' : 'not found']);
}
