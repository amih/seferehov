// The local title / author index (ref_titles, ref_authors: Hebrew Wikipedia, Wikidata,
// Ben-Yehuda; filled by scripts/import-refs.js). A spine reading no catalogue knows is
// looked up here before the web: candidates come from a trigram search on heb_fold (the
// key where look-alike letters and ו/י spellings fold together), then each is scored on
// the real spelling (titleSimilarity) and on the author.
//
// A candidate is taken when
//   - its title is very close to the reading (or to a part of it: "author • title"), and the
//     author read on the spine, if any, does not belong to someone else; or
//   - nearly all its title words are close to words on the spine and its author is too;
//   - short titles (under 8 letters) always need the author as well.
import { many } from './db.js';
import { normTitle, titleSimilarity } from './vision.js';
import { wordsKept } from './websearch.js';
import { step } from './trace.js';

const TITLE_CLOSE = 0.85;
const AUTHOR_CLOSE = 0.5; // share of the candidate author's words close to words on the spine
const SHORT = 8;

const letters = (s) => normTitle(s).replace(/ /g, '').length;
// The reading and its parts: "סנדר שיר • מורה מדליה" → itself, "סנדר שיר", "מורה מדליה".
const partsOf = (s) => [...new Set([s, ...s.split(/\s+[•·|/–-]\s+|\s*:\s*/)].map((x) => x.trim()).filter((x) => letters(x) >= 3))];
const mainTitle = (t) => t.split(/\s+[:/]\s+|\s*:\s*/)[0].trim();

async function candidates(queries) {
  const seen = new Map();
  for (const q of queries.slice(0, 5)) {
    const rows = await many(
      `SELECT id, title, author, year, source, ref, similarity(title_f, heb_fold($1)) AS s
         FROM ref_titles WHERE title_f % heb_fold($1) ORDER BY s DESC LIMIT 20`, [q]);
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()];
}

// The author name the index knows that is closest to what was read, or null.
export async function knownAuthor(name) {
  if (!name || letters(name) < 4) return null;
  const rows = await many(
    `SELECT DISTINCT ON (name) name, source, ref FROM ref_authors WHERE name_f % heb_fold($1) ORDER BY name, similarity(name_f, heb_fold($1)) DESC LIMIT 20`, [name]);
  const best = rows.map((r) => ({ ...r, s: titleSimilarity(r.name, name) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.75 ? best : null;
}

// { match: { title, author, source, ref, score } | null, author: corrected author | null, outcome, candidates }
//   outcome: corrected | confirmed | author_corrected | unknown
export async function localCheck(title, author) {
  const read = [title, author].filter(Boolean).join(' ');
  // The model sometimes puts the author in the title field and the title in the author's.
  const queries = [...partsOf(title), ...(author ? partsOf(author) : [])];
  const scored = (await candidates(queries)).map((c) => {
    const main = mainTitle(c.title);
    const ts = Math.max(...queries.map((q) => titleSimilarity(main, q)));
    const tw = wordsKept(main, read);
    const as = c.author ? wordsKept(c.author, read) : null;
    const authorOk = as !== null && as >= AUTHOR_CLOSE;
    // The spine shows an author and the candidate has a different one: another book.
    const otherAuthor = author && as !== null && as === 0;
    const short = letters(main) < SHORT;
    const ok = !otherAuthor && ((ts >= TITLE_CLOSE && (!short || authorOk)) || (tw >= 0.75 && authorOk));
    // Keep the subtitle only when the spine shows it too.
    const shown = wordsKept(c.title, read) >= 0.75 ? c.title : main;
    return { title: shown, author: c.author, source: c.source, ref: c.ref, year: c.year, ts, tw, as, ok, score: ts + 0.5 * (as ?? 0) };
  }).sort((a, b) => b.score - a.score);
  const match = scored.find((c) => c.ok) ?? null;
  let fixedAuthor = null;
  if (!match?.author && author) {
    const known = await knownAuthor(author);
    if (known && normTitle(known.name) !== normTitle(author)) fixedAuthor = known;
  }
  const outcome = match
    ? (normTitle(match.title) === normTitle(title) && (!match.author || normTitle(match.author) === normTitle(author)) ? 'confirmed' : 'corrected')
    : fixedAuthor ? 'author_corrected' : 'unknown';
  const top = scored.slice(0, 5).map(({ title: t, author: a, source, ref, ts, tw, as, ok }) => ({ title: t, author: a, source, ref, ts: +ts.toFixed(2), tw: +tw.toFixed(2), as: as == null ? null : +as.toFixed(2), ok }));
  await step('local-index', { read: { title, author: author ?? null }, queries, candidates: top,
    fixed: match ? { title: match.title, author: match.author ?? fixedAuthor?.name ?? author ?? null } : fixedAuthor ? { title, author: fixedAuthor.name } : null,
    source: match?.source ?? fixedAuthor?.source ?? null, verdict: outcome });
  return { match: match && { ...match, author: match.author ?? fixedAuthor?.name ?? null }, author: fixedAuthor?.name ?? null, authorSource: fixedAuthor?.source ?? null, outcome, candidates: top };
}
