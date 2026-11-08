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
import { unknownWords, plainWord } from './hebfix.js';

const RESULTS = 8;
const WORD_NEAR = 0.6; // a corrected word must be this alike to some word read on the spine
const WORDS_KEPT = 0.75; // …for this share of the corrected words

// Playing nice with the free engines behind SearXNG. Each search goes to ONE engine, taken in
// turn (Brave, Yandex, Yahoo; Mwmbl when they are all resting), so each sees a share:
//   - one search at a time, at least GAP_MS apart (plus a random 0–5 s);
//   - per engine at most PER_HOUR searches an hour and PER_DAY a day;
//   - an engine that answers nothing, a CAPTCHA or "too many requests" rests for COOL_MS;
//   - the same query is answered from web_search_cache for 30 days.
// A check that cannot be searched now is queued and run later, slowly (webqueue.js).
const GAP_MS = 10_000;
const ENGINES = [
  { name: 'brave', perHour: 15, perDay: 100 },
  { name: 'yandex', perHour: 15, perDay: 100 },
  { name: 'yahoo', perHour: 15, perDay: 100 },
  { name: 'mwmbl', perHour: 10, perDay: 60, last: true }, // a small open index: when the others rest
];
const COOL_MS = 30 * 60_000;
const KEEP_DAYS = 30;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const use = new Map(ENGINES.map((e) => [e.name, { sent: [], coolUntil: 0 }]));
let chain = Promise.resolve();
let last = 0;
let turn = 0;

// The engines that may be asked now, in turn order.
function ready() {
  const now = Date.now();
  const ok = ENGINES.filter((e) => {
    const u = use.get(e.name);
    while (u.sent.length && u.sent[0] < now - 86_400_000) u.sent.shift();
    return now >= u.coolUntil && u.sent.filter((t) => t > now - 3_600_000).length < e.perHour && u.sent.length < e.perDay;
  });
  const main = ok.filter((e) => !e.last);
  const order = main.length ? [...main.slice(turn % main.length), ...main.slice(0, turn % main.length)] : ok;
  return order;
}
// Why no search can be sent now, or null.
export function held() {
  if (!config.searchUrl) return 'search is off';
  return ready().length ? null : 'every engine is resting or used up for now';
}
// Searches left today (all engines), for the queue's pace.
export function searchesLeft() {
  return ENGINES.reduce((a, e) => a + Math.max(0, e.perDay - use.get(e.name).sent.length), 0);
}

async function searxng(query, engine) {
  const url = `${config.searchUrl}/search?${new URLSearchParams({ q: query, format: 'json', engines: engine })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  const results = (data.results ?? []).filter((r) => (r.engines ?? [r.engine]).includes(engine)).slice(0, RESULTS)
    .map((r) => ({ title: String(r.title ?? ''), text: String(r.content ?? '').slice(0, 300), url: r.url, engines: r.engines ?? (r.engine ? [r.engine] : []) }));
  const refused = (data.unresponsive_engines ?? []).find(([name]) => name === engine)?.[1] ?? null;
  return { results, refused };
}

// { results, cached, engine } or throws "not searched: …". An engine that refuses is rested
// and the next one asked (up to 2 engines a query).
async function search(query) {
  const key = query.replace(/\s+/g, ' ').trim();
  const hit = await one(`SELECT results FROM web_search_cache WHERE query = $1 AND at > now() - make_interval(days => $2)`, [key, KEEP_DAYS]).catch(() => null);
  if (hit) return { results: hit.results, cached: true };
  const job = chain.then(async () => {
    for (let tries = 0; tries < 2; tries++) {
      const why = held();
      if (why) throw new Error(`not searched: ${why}`);
      const engine = ready()[0];
      turn++;
      const wait = last + GAP_MS + Math.random() * 5000 - Date.now();
      if (wait > 0) await pause(wait);
      last = Date.now();
      const u = use.get(engine.name);
      u.sent.push(last);
      const { results, refused } = await searxng(key, engine.name).catch((err) => ({ results: [], refused: err.message }));
      // Nothing at all from a big engine is a sign it is holding us back; a quoted sentence may
      // simply not be anywhere, so only a refusal rests the engine then.
      if (refused || (!results.length && !key.startsWith('"'))) u.coolUntil = Date.now() + COOL_MS;
      if (refused) continue;
      if (results.length) await q(`INSERT INTO web_search_cache(query, results) VALUES ($1, $2) ON CONFLICT (query) DO UPDATE SET results = $2, at = now()`, [key, JSON.stringify(results)]).catch(() => {});
      return { results, cached: false, engine: engine.name };
    }
    throw new Error('not searched: the engines refused');
  });
  chain = job.catch(() => {});
  return job;
}

export async function purgeSearchCache() {
  await q(`DELETE FROM web_search_cache WHERE at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
}

async function ask(prompt) {
  const res = await fetch(`${config.vision.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.vision.model, prompt, stream: false, think: false, keep_alive: '3m',
      options: { num_ctx: 8192, num_predict: 120, temperature: 0 } }),
    signal: AbortSignal.timeout(config.vision.timeoutMs), // includes any wait in the GPU queue
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  return String((await res.json()).response ?? '').trim();
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

// Hosts (and engines) of the results that spell the corrected title: which sites helped.
function helpers(results, fixed) {
  const want = normTitle(fixed.title);
  const used = results.filter((r) => normTitle(`${r.title} ${r.text}`).includes(want));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
  return { sites: [...new Set(used.map((r) => host(r.url)).filter(Boolean))], engines: [...new Set(used.flatMap((r) => r.engines ?? []))] };
}

// { fixed: { title, author } | null, outcome, tries: [{ query, verdict, cached, sites, engines }] }
//   outcome: corrected | confirmed (the web spells it as read) | unknown | held (not searched)
export async function webCheck(title, author) {
  const tries = [];
  if (!config.searchUrl || !title) return { fixed: null, outcome: 'off', tries };
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
      results: (r.results ?? []).map((x) => ({ title: x.title, text: x.text.slice(0, 160), url: x.url, engines: x.engines })),
      answer: r.answer, fixed: r.fixed, kept: r.kept, cached: r.cached, verdict: r.verdict, ms: Date.now() - t0 });
    const used = r.fixed && r.verdict === 'corrected' ? helpers(r.results, r.fixed) : { sites: [], engines: [] };
    tries.push({ query, verdict: r.verdict, cached: !!r.cached, ...used });
    if (r.verdict.startsWith('not searched')) return { fixed: null, outcome: 'held', tries }; // no second query either
    if (r.verdict === 'corrected') {
      const same = normTitle(r.fixed.title) === normTitle(title) && normTitle(r.fixed.author) === normTitle(author);
      return { fixed: same ? null : r.fixed, outcome: same ? 'confirmed' : 'corrected', tries };
    }
  }
  return { fixed: null, outcome: 'unknown', tries };
}

// The back cover's blurb, searched word for word: pages that quote it (bookshops, Goodreads,
// publishers) name the book in their titles. Only the search results are read, no site.
// Measured on 8 Nov 2026: a back photographed without its front ("נכנסתי לחדר המלון בקומה
// העשירית משוכנעת") gave "זה לא שאני לא אוהבת" by אורית הראל at once.
// Phrases: runs of 6–8 words in one sentence that hspell knows (Hebrew) or that are plain
// words (Latin), so an OCR slip does not break the exact match; at most 2 searched.
const PHRASE = [6, 8];
export async function phrasesOf(text) {
  const sentences = String(text ?? '').split(/[.!?;\n"״”“]+/).map((x) => x.trim()).filter(Boolean);
  const clean = (w) => w.replace(/^[(\[«'"]+|[)\]»,:'"]+$/g, '');
  const all = sentences.flatMap((x) => x.split(/\s+/)).map(clean);
  const bad = await unknownWords(all.filter((w) => /[\u0590-\u05FF]/.test(w)));
  const good = (w) => (/[\u0590-\u05FF]/.test(w) ? !bad.has(plainWord(w)) && plainWord(w).length >= 2 : /^[A-Za-z'’-]{2,}$/.test(w));
  const runs = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).map(clean);
    let best = [];
    for (let i = 0, run = []; i <= words.length; i++) {
      if (i < words.length && words[i] && good(words[i])) { run.push(words[i]); continue; }
      if (run.length > best.length) best = run;
      run = [];
    }
    if (best.length >= PHRASE[0]) runs.push(best.slice(0, PHRASE[1]).join(' '));
  }
  // Longer first; one per sentence.
  return [...new Set(runs)].sort((a, b) => b.length - a.length).slice(0, 2);
}

// { found: { title, author } | null, outcome, tries }
export async function blurbSearch(text) {
  const tries = [];
  if (!config.searchUrl) return { found: null, outcome: 'off', tries };
  for (const phrase of await phrasesOf(text)) {
    const query = `"${phrase}"`;
    let results = [], verdict, found = null, answer = null, cached = false;
    try { ({ results, cached } = await search(query)); } catch (err) { verdict = err.message; }
    if (!verdict && !results.length) verdict = 'no results';
    if (!verdict) {
      const listing = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.text}`).join('\n');
      answer = await ask(`These web search results were found by searching for a sentence from a book's back cover: "${phrase}".
${listing}

If the results clearly name the book this sentence is from, answer one line: TITLE | AUTHOR, spelled exactly as in the results, in the original language. If they do not, answer NONE.`).catch(() => 'NONE');
      const line = answer.split('\n')[0].replace(/^["'*\s]+|["'*\s]+$/g, '');
      const [t, a] = line.split('|').map((x) => x?.trim().replace(/^["']|["']$/g, ''));
      // Kept when written in the results, by at least two of them or by one that quotes the phrase.
      const naming = t && !/^none\b/i.test(t) ? results.filter((r) => normTitle(`${r.title} ${r.text}`).includes(normTitle(t))) : [];
      const quoting = naming.filter((r) => wordsKept(phrase, r.text) >= 0.6);
      if (!naming.length) verdict = t && !/^none\b/i.test(t) ? 'dropped: the answer is not written in the results' : 'the results do not name a book';
      else if (naming.length < 2 && !quoting.length) verdict = 'dropped: one result names it and does not quote the sentence';
      else { found = { title: t, author: a && !/^(unknown|none|-)$/i.test(a) ? a : null }; verdict = 'found'; }
    }
    await step('blurb-search', { query, results: results.map((x) => ({ title: x.title, text: x.text.slice(0, 160), url: x.url })), answer, found, cached, verdict });
    tries.push({ query, verdict, cached });
    if (found) return { found, outcome: 'found', tries };
    if (String(verdict).startsWith('not searched')) return { found: null, outcome: 'held', tries };
  }
  return { found: null, outcome: tries.length ? 'unknown' : 'no phrase', tries };
}

// Titles the web names for one author: the parts of the results' titles ("שם הספר – שם
// הסופר | הוצאה") and quoted names in their snippets. One search (the same throttle).
export async function authorTitles(name) {
  if (!config.searchUrl || !name) return { titles: [], verdict: 'off' };
  const query = `"${name}" ${/[א-ת]/.test(name) ? 'ספר' : 'book'}`;
  let results = [], verdict = 'searched', cached = false;
  try { ({ results, cached } = await search(query)); } catch (err) { verdict = err.message; }
  const titles = new Set();
  for (const r of results) {
    for (const part of r.title.split(/\s+[|–—-]\s+|\s*[|:·/]\s*|\s+by\s+/i)) if (part.trim().length >= 3) titles.add(part.trim());
    for (const m of r.text.matchAll(/[«"“”״]([^«»"“”״]{3,60})[»"“”״]/g)) titles.add(m[1].trim());
  }
  await step('author-search', { query, cached, verdict, titles: [...titles].slice(0, 40) });
  return { titles: [...titles].map((title) => ({ title, author: name, source: 'web' })), verdict };
}
