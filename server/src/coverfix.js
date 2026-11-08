// Finding a cover's book by its author: among the author's books (local index, the National
// Library, else one web search), the one whose title is printed on the cover.
import { knownAuthor, titlesBy } from './refindex.js';
import { nliTitlesBy } from './books.js';
import { authorTitles, wordsKept } from './websearch.js';
import { normTitle, titleSimilarity } from './vision.js';
import { step } from './trace.js';

// Among an author's books, the one whose title is printed on the cover: every word of its main
// title close to a word read there (look-alike letters count as close); a one-word title must be
// nearly the same as a word read. The surest wins; two different titles as sure: none.
export function titleOnCover(candidates, coverText) {
  const words = normTitle(coverText).split(' ').filter((w) => w.length >= 2);
  const scored = [];
  for (const c of candidates) {
    const main = String(c.title).split(/\s+[:/–-]\s+|\s*:\s*/)[0].trim();
    const mw = normTitle(main).split(' ').filter(Boolean);
    if (!mw.length || normTitle(main).replace(/ /g, '').length < 3) continue;
    const score = mw.length === 1 ? Math.max(0, ...words.map((w) => titleSimilarity(w, mw[0]))) : wordsKept(main, coverText);
    if (score >= (mw.length === 1 ? 0.8 : 0.75)) scored.push({ ...c, title: main, score, n: mw.length });
  }
  scored.sort((a, b) => b.score - a.score || b.n - a.n);
  const [top, next] = scored;
  if (!top) return null;
  if (next && normTitle(next.title) !== normTitle(top.title) && next.score === top.score && next.n === top.n) return null;
  return top;
}
export async function titleByAuthor(author, coverText, { web = true } = {}) {
  const known = await knownAuthor(author).catch(() => null);
  const name = known?.name ?? author;
  const seen = new Set();
  const uniq = (list) => list.filter((c) => { const k = normTitle(c.title); if (seen.has(k)) return false; seen.add(k); return true; });
  let cands = uniq([...await titlesBy(name).catch(() => []), ...(/[א-ת]/.test(name) ? await nliTitlesBy(name).catch(() => []) : [])]);
  let pick = titleOnCover(cands, coverText);
  let verdict = pick ? 'found offline' : 'no offline title fits';
  if (!pick && web) {
    const found = await authorTitles(name);
    const more = uniq(found.titles);
    cands = cands.concat(more);
    pick = titleOnCover(more, coverText);
    verdict = pick ? 'found on the web' : `none fits (web: ${found.verdict})`;
  }
  await step('author-first', { note: "the author's books held against the cover's text", read: author, name, candidates: cands.length, pick, verdict });
  return { pick: pick && { title: pick.title, author: pick.author ?? name, source: pick.source }, name, count: cands.length, verdict, held: /not searched/.test(verdict) };
}

