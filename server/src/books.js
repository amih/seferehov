import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { one, many, q } from './db.js';
import { normalizeIsbn, normalizeDanacode } from './util.js';
import { normTitle } from './vision.js';
import { config } from './config.js';

const UA = 'Seferehov/0.1 (https://seferehov.com)';

// --- Statistics: every search goes to table lookups, every request to a source to
// lookup_calls (see db/migrations/007_lookup_stats.sql). Never breaks a lookup.
const lookupCtx = new AsyncLocalStorage(); // { id, calls } of the search in progress
const callCtx = new AsyncLocalStorage();   // what happened to the source request in progress

function noteResponse(res, limited = false) {
  const c = callCtx.getStore();
  if (!c) return;
  c.attempts++;
  c.status = res?.status ?? null;
  c.limited = limited || res?.status === 429;
  c.error = !res ? 'network error' : !res.ok && !c.limited ? `HTTP ${res.status}` : null;
}

// A source that reports its quota used up is left alone for an hour.
const pausedUntil = {};
const PAUSE_MS = 60 * 60_000;

// Times one request to a source and notes how it went. count() says how many
// records came back. Returns null without asking when the source is paused.
async function track(source, fn, count = (r) => (Array.isArray(r) ? r.length : r ? 1 : 0)) {
  if (pausedUntil[source] > Date.now()) return null;
  const c = { attempts: 0 };
  const t0 = Date.now();
  let res, err;
  try { res = await callCtx.run(c, fn); } catch (e) { err = e; }
  if (c.skipped) return res;
  const results = err ? 0 : count(res);
  const call = {
    source, results, ms: Date.now() - t0, http_status: c.status ?? null, attempts: Math.max(c.attempts, 1),
    outcome: c.limited ? 'limited' : err || c.error ? 'error' : results ? 'hit' : 'miss',
    error: (err?.message ?? c.error ?? null)?.slice(0, 300) ?? null,
  };
  if (call.outcome === 'limited') pausedUntil[source] = Date.now() + PAUSE_MS;
  const store = lookupCtx.getStore();
  if (store) store.calls.push(call);
  else saveCalls(null, [call]);
  if (err) throw err;
  return res;
}

function saveCalls(lookupId, calls) {
  if (!calls.length) return Promise.resolve();
  const cols = ['source', 'outcome', 'http_status', 'attempts', 'results', 'ms', 'error'];
  const vals = [];
  const rows = calls.map((c) => `($1, ${cols.map((k) => { vals.push(c[k]); return `$${vals.length + 1}`; }).join(', ')})`);
  return q(`INSERT INTO lookup_calls(lookup_id, ${cols.join(', ')}) VALUES ${rows.join(', ')}`, [lookupId, ...vals])
    .catch(() => {});
}

// Runs one search and records it. fn returns { book, source?, score?, ... }.
async function withLookup(info, fn) {
  const store = { id: randomUUID(), calls: [] };
  const t0 = Date.now();
  const { source, score, ...result } = await lookupCtx.run(store, fn);
  try {
    await q(
      `INSERT INTO lookups(id, kind, query, author, hebrew, context, book_id, source, score, ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [store.id, info.kind, info.query, info.author ?? null, info.hebrew, info.context,
       result.book?.id ?? null, result.book ? source ?? null : null, score ?? null, Date.now() - t0],
    );
    await saveCalls(store.id, store.calls);
  } catch { return result; }
  return { ...result, lookupId: store.id };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  // Google answers 429, or 403 with a "quota"/"limit" message, when the quota is used up.
  if (res?.status === 403) {
    noteResponse(res, /quota|limit/i.test(await res.text().catch(() => '')));
    return null;
  }
  noteResponse(res);
  return res?.ok ? res.json() : null;
}

async function fromOpenLibrary(isbn) {
  const data = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const b = data?.[`ISBN:${isbn}`];
  if (!b?.title) return null;
  const year = Number(String(b.publish_date ?? '').match(/\d{4}/)?.[0]) || null;
  return {
    title: b.subtitle ? `${b.title}: ${b.subtitle}` : b.title,
    authors: (b.authors ?? []).map((a) => a.name),
    publisher: b.publishers?.[0]?.name ?? null,
    year,
    language: null,
    cover_url: b.cover?.medium ?? null,
    source: 'openlibrary',
    source_ids: { openlibrary: b.key },
  };
}

async function fromGoogleBooks(isbn) {
  const data = await getJson(gbUrl(`q=isbn:${isbn}`));
  const item = data?.items?.[0];
  const v = item?.volumeInfo;
  if (!v?.title) return null;
  return {
    title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    authors: v.authors ?? [],
    publisher: v.publisher ?? null,
    year: Number(String(v.publishedDate ?? '').slice(0, 4)) || null,
    language: v.language ?? null,
    cover_url: v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null,
    source: 'googlebooks',
    source_ids: { googlebooks: item.id },
  };
}

// National Library of Israel (legal deposit for every book published in Israel).
// Needs a free key from https://api2.nli.org.il (NLI_API_KEY); skipped without one.
const DC = 'http://purl.org/dc/elements/1.1/';
const dc = (item, k) => (item[DC + k] ?? []).map((v) => v['@value']).filter(Boolean);

// The API answers 502 to bursts: space calls out and retry a couple of times.
let nliChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nliFetch(url) {
  const job = nliChain.then(async () => {
    for (const wait of [0, 2000, 6000]) {
      if (wait) await sleep(wait);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      noteResponse(res);
      if (res?.ok) return res.json();
      if (res && res.status < 500 && res.status !== 429) return null;
    }
    return null;
  });
  nliChain = job.then(() => sleep(1500), () => sleep(1500));
  return job;
}

// "עוז, עמוס, 1939-2018 מחבר$$Q…" → "עמוס עוז"
function nliAuthor(a) {
  const name = a.replace(/\$\$.*$/, '').replace(/[,.]?\s*\d{4}-(\d{4})?\.?/, '')
    .replace(/\s+(מחבר|מחברת|author|editor|עורך|עורכת)\.?\s*$/i, '').replace(/[.,\s]+$/, '').trim();
  const [last, first, ...rest] = name.split(/,\s*/);
  return first && !rest.length ? `${first} ${last}` : name;
}

async function nliSearch(query) {
  if (!config.nliApiKey) {
    if (callCtx.getStore()) callCtx.getStore().skipped = true; // not configured: nothing to record
    return [];
  }
  const url = `https://api.nli.org.il/openlibrary/search?api_key=${encodeURIComponent(config.nliApiKey)}`
    + `&query=${encodeURIComponent(query)}&material_type=books&output_format=json&limit=10`;
  const data = await nliFetch(url);
  // material_type is not enforced: drop photos, recordings, videos, theses.
  return (Array.isArray(data) ? data : []).filter((item) => dc(item, 'type').includes('book')).map((item) => {
    const isbn = dc(item, 'identifier').map((x) => normalizeIsbn(x.replace(/\(.*\)/, ''))).find(Boolean) ?? null;
    // "Title : subtitle / Author ; translator." → title "Title : subtitle", bare "Title"
    const title = dc(item, 'title')[0]?.split(' / ')[0].replace(/[\s.:/]+$/, '');
    return {
      title,
      bare: title?.split(' : ')[0],
      authors: dc(item, 'creator').map(nliAuthor).filter(Boolean),
      publisher: dc(item, 'publisher')[0] ?? null,
      year: Number(String(dc(item, 'date')[0] ?? dc(item, 'non_standard_date')[0] ?? '').match(/\d{4}/)?.[0]) || null,
      language: dc(item, 'language')[0] ?? null,
      cover_url: dc(item, 'thumbnail')[0] ?? null,
      isbn,
      source: 'nli',
      source_ids: { nli: dc(item, 'recordid')[0] ?? item['@id'] },
    };
  }).filter((b) => b.title);
}

async function fromNli(isbn) {
  const hit = (await nliSearch(`any,contains,${isbn}`)).find((b) => !b.isbn || b.isbn === isbn);
  if (!hit) return null;
  const { isbn: _, ...meta } = hit;
  return meta;
}

// Without a key Google Books shares a small anonymous daily quota with the world.
const gbUrl = (qs) => `https://www.googleapis.com/books/v1/volumes?${qs}${config.googleBooksKey ? `&key=${encodeURIComponent(config.googleBooksKey)}` : ''}`;

// Local copy of the Open Library catalogue (see deploy/ol-refresh.sh).
const fromLocal = (r) => r && ({
  title: r.title, authors: r.authors, publisher: r.publisher, year: r.year, language: r.lang,
  cover_url: r.cover_id ? `https://covers.openlibrary.org/b/id/${r.cover_id}-M.jpg` : null,
  source: 'openlibrary', source_ids: { openlibrary: r.ol_key },
});
async function fromLocalIsbn(isbn) {
  return fromLocal(await one('SELECT * FROM ol_books WHERE isbn13 = $1 LIMIT 1', [isbn]).catch(() => null));
}
async function localTitleCandidates(title) {
  const q = normTitle(title);
  if (q.length < 3) return [];
  // word_similarity: how well the read title matches a run of words in the record
  // (records also carry subtitles and alternative titles).
  return many(
    `SELECT *, word_similarity($1, tnorm) AS ws FROM ol_books
      WHERE $1 <% tnorm ORDER BY ws DESC, isbn13 IS NULL, year DESC NULLS LAST LIMIT 15`,
    [q],
  ).catch(() => []);
}

const isHebrew = (s) => /[\u0590-\u05FF]/.test(s ?? '');

// Finds a book by ISBN: local table first, then Open Library, Google Books, and the
// National Library of Israel (Israeli ISBNs start 978-965).
// Returns { book } or { book: null, isbn } when nothing was found.
export async function lookupIsbn(raw, context = 'isbn_lookup') {
  const isbn = normalizeIsbn(raw);
  if (!isbn) {
    // Israeli books often carry a Danacode instead. No open catalogue answers by
    // Danacode, so only books someone here has named already are found.
    const danacode = normalizeDanacode(raw);
    if (!danacode) return { error: 'invalid_isbn' };
    return { book: await one('SELECT * FROM books WHERE danacode = $1', [danacode]), isbn: null, danacode };
  }
  const israeli = isbn.startsWith('978965');
  return withLookup({ kind: 'isbn', query: isbn, hebrew: israeli, context }, async () => {
    const existing = await one('SELECT * FROM books WHERE isbn13 = $1', [isbn]);
    if (existing) return { book: existing, source: 'cache' };

    const local = ['local_ol', fromLocalIsbn], nli = ['nli', fromNli];
    const gb = ['googlebooks', fromGoogleBooks], ol = ['openlibrary', fromOpenLibrary];
    for (const [name, src] of israeli ? [local, nli, gb, ol] : [local, ol, gb, nli]) {
      let meta = null;
      try { meta = await track(name, () => src(isbn)); } catch { /* next source */ }
      if (meta) return { book: await upsertBook({ ...meta, isbn13: isbn }), source: name };
    }
    return { book: null, isbn };
  });
}

export async function upsertBook(b) {
  if (b.danacode && !b.isbn13) {
    const known = await one('SELECT * FROM books WHERE danacode = $1', [b.danacode]);
    if (known) return known;
  }
  return one(
    `INSERT INTO books(isbn13, title, authors, publisher, year, language, cover_url, source, source_ids, danacode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (isbn13) DO UPDATE SET isbn13 = EXCLUDED.isbn13
     RETURNING *`,
    [b.isbn13 ?? null, b.title, b.authors ?? [], b.publisher ?? null, b.year ?? null,
     b.language ?? null, b.cover_url ?? null, b.source, b.source_ids ?? {}, b.isbn13 ? null : b.danacode ?? null],
  );
}

// For books without an ISBN: reuse a row with the same title and first author (also
// when the two were entered in each other's fields).
export async function findOrCreateBook(b) {
  if (b.isbn13 || b.danacode) return upsertBook(b);
  const existing = await one(
    `SELECT * FROM books WHERE (lower(title) = lower($1)
        AND (cardinality(authors) = 0 OR $2::text IS NULL OR lower(authors[1]) = lower($2)))
        OR ($2::text IS NOT NULL AND lower(title) = lower($2) AND lower(authors[1]) = lower($1))
      ORDER BY lower(title) = lower($1) DESC, isbn13 IS NULL, id LIMIT 1`,
    [b.title, b.authors?.[0] ?? null],
  );
  return existing ?? upsertBook(b);
}

// A scanned ISBN or Danacode belongs to this book: kept on it when it has none, or on
// a new row for this edition when it has another one. A code already held by another
// book is left there (the reader may have corrected a wrong catalogue match).
export async function withCode(book, code) {
  const isbn = normalizeIsbn(code), danacode = isbn ? null : normalizeDanacode(code);
  const col = isbn ? 'isbn13' : danacode ? 'danacode' : null;
  const value = isbn ?? danacode;
  if (!col || book[col] === value) return book;
  if (await one(`SELECT 1 FROM books WHERE ${col} = $1`, [value])) return book;
  if (!book[col]) return one(`UPDATE books SET ${col} = $2 WHERE id = $1 RETURNING *`, [book.id, value]);
  const { title, authors, publisher, year, language } = book;
  return upsertBook({ title, authors, publisher, year, language, source: 'user', isbn13: isbn, danacode });
}

const words = (s) => new Set(normTitle(s).split(' ').filter((w) => w.length > 1));
// Dice coefficient on words: 1 = same words, 0 = nothing in common.
// Share of the read title's words found in b (b may hold several titles).
function containment(a, b) {
  const A = words(a), B = new Set(String(b).split(' '));
  if (!A.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / A.size;
}

function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return (2 * n) / (A.size + B.size);
}

// Finds a catalogue record for a title (and author) read off a spine or cover.
// Returns { book } on a confident match, otherwise { book: null }.
// verify(candidate): when given, only a record it accepts can match (e.g. one whose
// title agrees with all the text read off the covers).
export async function lookupTitle(title, author, context = 'scan', verify = null) {
  return withLookup({ kind: 'title', query: title, author, hebrew: isHebrew(title), context }, async () => {
    const r = await searchTitle(title, author, verify);
    // A misread author name hides good matches; try the title alone.
    return r.book || !author ? r : searchTitle(title, null, verify);
  });
}

// Books already here (some added by readers, found in no catalogue).
async function appTitleCandidates(title) {
  const q = normTitle(title);
  if (q.length < 3) return [];
  return many(`SELECT * FROM books WHERE $1 <% search ORDER BY word_similarity($1, search) DESC, isbn13 IS NULL LIMIT 10`, [q]).catch(() => []);
}

async function searchTitle(title, author, verify) {
  const mine = [];
  for (const b of await appTitleCandidates(title)) mine.push({ ...b, bare: b.title, alt: null, via: 'app', book: b });
  const here = pickBest(mine, title, author, verify);
  if (here) return { book: here.book, source: 'app', score: here.score };
  const candidates = [];
  for (const r of await track('local_ol', () => localTitleCandidates(title)).catch(() => [])) {
    candidates.push({ ...fromLocal(r), bare: r.title, isbn: r.isbn13, alt: r.tnorm, via: 'local_ol' });
  }
  const local = pickBest(candidates, title, author, verify);
  if (local) return { book: await saveCandidate(local, title), source: local.via, score: local.score };
  // Hebrew titles: the National Library has nearly every Israeli book.
  if (isHebrew(title)) {
    try {
      for (const b of await track('nli', () => nliSearch(`title,contains,${title}`)) ?? []) candidates.push({ ...b, via: 'nli' });
    } catch { /* fall through to Google Books */ }
  }
  const q = [`intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join(' ');
  if (!pickBest(candidates, title, author, verify)) try {
    const gb = await track('googlebooks', () => getJson(gbUrl(`maxResults=5&q=${encodeURIComponent(q)}`)), (r) => r?.items?.length ?? 0);
    for (const item of gb?.items ?? []) {
      const v = item.volumeInfo;
      const isbn = v.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier;
      candidates.push({ title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title, bare: v.title, authors: v.authors ?? [], isbn,
        publisher: v.publisher ?? null, year: Number(String(v.publishedDate ?? '').slice(0, 4)) || null, language: v.language ?? null,
        cover_url: v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null, source: 'googlebooks', source_ids: { googlebooks: item.id }, via: 'googlebooks' });
    }
  } catch { /* try Open Library */ }
  if (!pickBest(candidates, title, author, verify)) {
    try {
      const ol = await track('openlibrary', () => getJson(`https://openlibrary.org/search.json?limit=5&fields=key,title,author_name,isbn,first_publish_year,cover_i&title=${encodeURIComponent(title)}${author ? `&author=${encodeURIComponent(author)}` : ''}`), (r) => r?.docs?.length ?? 0);
      for (const d of ol?.docs ?? []) {
        candidates.push({ title: d.title, bare: d.title, authors: d.author_name ?? [], isbn: d.isbn?.find((i) => i.length === 13),
          publisher: null, year: d.first_publish_year ?? null, language: null,
          cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null, source: 'openlibrary', source_ids: { openlibrary: d.key }, via: 'openlibrary' });
      }
    } catch { /* no match */ }
  }
  const best = pickBest(candidates, title, author, verify);
  // On a miss, keep the closest score anyway: it helps tune the 0.7 threshold.
  return best ? { book: await saveCandidate(best, title), source: best.via, score: best.score }
    : { book: null, score: rankBest(candidates, title, author, verify).score || null };
}

// Dice on letter pairs: tolerates spelling variants, so only counts when very close.
function charSimilarity(a, b) {
  const pairs = (s) => { const t = normTitle(s).replace(/ /g, ''), m = new Map(); for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1); return m; };
  const A = pairs(a), B = pairs(b);
  let n = 0, na = 0, nb = 0;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) { na += v; n += Math.min(v, B.get(k) ?? 0); }
  return na && nb ? (2 * n) / (na + nb) : 0;
}

function pickBest(candidates, title, author, verify) {
  const { best, score } = rankBest(candidates, title, author, verify);
  return best && score >= 0.7 ? { ...best, score } : null;
}

const mainTitle = (s) => String(s ?? '').split(':')[0];

function rankBest(candidates, title, author, verify) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (verify && !verify(c)) continue;
    const chars = Math.max(charSimilarity(title, c.title), charSimilarity(title, c.bare));
    // Alternative titles hold the Hebrew of romanized records; a read title found inside
    // them counts only as far as it covers the record's main title (a word or two read
    // off a spine is inside many long titles).
    const alt = c.alt && !isHebrew(c.title) ? containment(title, c.alt) * Math.min(1, words(title).size / (words(mainTitle(c.bare)).size || 1)) : 0;
    let score = Math.max(similarity(title, c.title), similarity(title, c.bare), similarity(title, mainTitle(c.bare)), alt,
      chars >= 0.9 ? chars * 0.8 : 0);
    // Prefer records in the script we read (the Hebrew edition over translations).
    if (isHebrew(title) !== isHebrew(c.title)) score *= 0.9;
    if (author && c.authors.length) score = score * 0.75 + 0.25 * Math.max(...c.authors.map((a) => similarity(author, a)));
    // A record naming no author loses a tie to one naming the author we read.
    else if (author) score *= 0.95;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return { best, score: bestScore };
}

async function saveCandidate(c, readTitle) {
  // Library of Congress style records give Hebrew books romanized titles; when the
  // Hebrew we read matches the record's alternative titles, show the Hebrew.
  if (readTitle && isHebrew(readTitle) && !isHebrew(c.title) && c.alt && containment(readTitle, c.alt) >= 0.8) {
    c = { ...c, title: readTitle };
  }
  const isbn13 = normalizeIsbn(c.isbn);
  if (isbn13) {
    const existing = await one('SELECT * FROM books WHERE isbn13 = $1', [isbn13]);
    if (existing) return existing;
  }
  const { bare, isbn, alt, via, score, ...meta } = c;
  return findOrCreateBook({ ...meta, isbn13 });
}
