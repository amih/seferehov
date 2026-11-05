// A spine reading that no catalogue knows is often one look-alike letter off ("ארונית
// התבלינים" for "אדונית התבלינים", "אתוות החוף" for "אחוזות החוף"), or has the
// author's name read into the title. The web knows the book: the reading is searched
// (SearXNG, throttled below), the model picks this book's title and author out of the results, and the
// answer is kept only when
//   - it is written in the results as given (not made up by the model), and
//   - nearly every word of it is close to a word that was read on the spine
//     (look-alike letters count as close), so a different book cannot replace it.
import { config } from './config.js';
import { normTitle, titleSimilarity } from './vision.js';
import { step } from './trace.js';
import { one, q } from './db.js';

const RESULTS = 8;
const WORD_NEAR = 0.6; // a corrected word must be this alike to some word read on the spine
const WORDS_KEPT = 0.75; // …for this share of the corrected words

// Playing nice with the free engines behind SearXNG (Brave pauses us after a burst):
//   - one search at a time, at least GAP_MS apart (plus a random 0–5 s);
//   - at most PER_HOUR searches an hour and PER_DAY a day; past that, readings stay as read;
//   - when the engines answer nothing (a sign they are holding us back), no searches for
//     COOL_MS;
//   - the same query is answered from web_search_cache for 30 days.
const GAP_MS = 10_000;
const PER_HOUR = 40;
const PER_DAY = 300;
const COOL_MS = 10 * 60_000;
const KEEP_DAYS = 30;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = []; // times of searches sent, the last 24 hours
let chain = Promise.resolve();
let last = 0;
let coolUntil = 0;

async function searxng(query) {
  const url = `${config.searchUrl}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`search ${res.status}`);
  return ((await res.json()).results ?? []).slice(0, RESULTS)
    .map((r) => ({ title: String(r.title ?? ''), text: String(r.content ?? '').slice(0, 300), url: r.url }));
}

// Why no search can be sent now, or null.
function held() {
  const now = Date.now();
  while (sent.length && sent[0] < now - 86_400_000) sent.shift();
  if (now < coolUntil) return `the search engines asked for a pause (until ${new Date(coolUntil).toISOString().slice(11, 16)} UTC)`;
  if (sent.filter((t) => t > now - 3_600_000).length >= PER_HOUR) return `${PER_HOUR} searches this hour`;
  if (sent.length >= PER_DAY) return `${PER_DAY} searches today`;
  return null;
}

// { results, cached } or throws "not searched: …".
async function search(query) {
  const key = query.replace(/\s+/g, ' ').trim();
  const hit = await one(`SELECT results FROM web_search_cache WHERE query = $1 AND at > now() - make_interval(days => $2)`, [key, KEEP_DAYS]).catch(() => null);
  if (hit) return { results: hit.results, cached: true };
  const job = chain.then(async () => {
    const why = held();
    if (why) throw new Error(`not searched: ${why}`);
    const wait = last + GAP_MS + Math.random() * 5000 - Date.now();
    if (wait > 0) await pause(wait);
    last = Date.now();
    sent.push(last);
    const results = await searxng(key);
    if (!results.length) coolUntil = Date.now() + COOL_MS;
    else await q(`INSERT INTO web_search_cache(query, results) VALUES ($1, $2) ON CONFLICT (query) DO UPDATE SET results = $2, at = now()`, [key, JSON.stringify(results)]).catch(() => {});
    return { results, cached: false };
  });
  chain = job.catch(() => {});
  return job;
}

export async function purgeSearchCache() {
  await q(`DELETE FROM web_search_cache WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
}

// Share of the words in `fixed` that are close to some word of `read`.
export function wordsKept(fixed, read) {
  const have = normTitle(read).split(' ').filter(Boolean);
  const want = normTitle(fixed).split(' ').filter((w) => w.length > 1);
  if (!want.length || !have.length) return 0;
  return want.filter((w) => have.some((h) => titleSimilarity(w, h) >= WORD_NEAR)).length / want.length;
}

// One search and the model's pick from it: { fixed, verdict, answer, results }.
async function tryQuery(query, title, author, read) {
  const { results, cached } = await search(query);
  if (!results.length) return { results, verdict: 'no results' };
  const listing = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.text}`).join('\n');
  const prompt = `A book spine was read by OCR as: "${title}${author ? ` | ${author}` : ''}". The OCR often confuses letters that look alike, and may have mixed the author's name into the title.
Web search results:
${listing}

If the results clearly name this book, answer one line: TITLE | AUTHOR, spelled exactly as in the results, in the original language. If they do not, answer NONE.`;
  const answer = await ask(prompt);
  const line = answer.split('\n')[0].replace(/^["'*\s]+|["'*\s]+$/g, '');
  if (!line || /^none\b/i.test(line)) return { results, answer, verdict: 'the results do not name this book' };
  let [t, a] = line.split('|').map((x) => x.trim().replace(/^["']|["']$/g, ''));
  // "Title / Author" (a catalogue's way of writing it) and a subtitle the spine does not show.
  if (t?.includes(' / ')) { const [x, y] = t.split(' / '); t = x.trim(); a ||= y.trim(); }
  if (t?.includes(':')) { const main = t.split(':')[0].trim(); if (main && wordsKept(t, read) < WORDS_KEPT) t = main; }
  const fixed = { title: t || title, author: a && !/^(unknown|none|-)$/i.test(a) ? a : author ?? null };
  const corpus = normTitle(results.map((r) => `${r.title} ${r.text}`).join(' '));
  if (!corpus.includes(normTitle(fixed.title))) return { results, answer, verdict: 'dropped: the answer is not written in the results' };
  const kept = wordsKept(fixed.title, read);
  if (kept < WORDS_KEPT) return { results, answer, fixed, verdict: `dropped: only ${Math.round(kept * 100)}% of the title's words are close to what the spine says` };
  // The author: one of the names close to the spine's, when the spine showed one.
  if (author && fixed.author && wordsKept(fixed.author, read) === 0) return { results, answer, fixed, verdict: 'dropped: another author' };
  return { results, answer, fixed, kept, cached, verdict: 'corrected' };
}

// { title, author } as the web spells it, or null.
export async function webCheck(title, author) {
  if (!config.searchUrl || !title) return null;
  const read = [title, author].filter(Boolean).join(' ');
  const book = /[א-ת]/.test(read) ? 'ספר' : 'book';
  // The whole reading first; then, when the title has parts ("author • title"), its longest part.
  const parts = title.split(/\s+[•·|/–-]\s+/).filter((x) => x.trim());
  const queries = [`${read.replace(/\s+[•·|/]\s+/g, ' ')} ${book}`];
  if (parts.length > 1) queries.push(`${parts.sort((x, y) => y.length - x.length)[0]} ${book}`);
  for (const query of queries) {
    const t0 = Date.now();
    let r;
    try { r = await tryQuery(query, title, author, read); } catch (err) { r = { results: [], verdict: err.message.startsWith('not searched') ? err.message : `not checked: ${err.message}` }; }
    await step('web-search', { query, read: { title, author: author ?? null },
      results: (r.results ?? []).map((x) => ({ title: x.title, text: x.text.slice(0, 160), url: x.url })),
      answer: r.answer, fixed: r.fixed, kept: r.kept, cached: r.cached, verdict: r.verdict, ms: Date.now() - t0 });
    if (r.verdict.startsWith('not searched')) return null; // held back: no second query either
    if (r.verdict === 'corrected') {
      const same = normTitle(r.fixed.title) === normTitle(title) && normTitle(r.fixed.author) === normTitle(author);
      return same ? null : r.fixed;
    }
  }
  return null;
}
