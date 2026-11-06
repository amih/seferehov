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

// National Library of Israel (legal deposit for every book published in Israel), through the
// catalogue's public SRU interface (Alma, MARC XML; no key). The older api.nli.org.il search
// went behind a browser check in November 2026. MARC gives names in Hebrew: fields marked
// $9 heb are used, and romanized ones ("Menaḥem Miśgav") only when a record has no Hebrew.
const SRU = 'https://nli.alma.exlibrisgroup.com/view/sru/972NNL_INST';

// Bursts get refused: space calls out and retry a couple of times.
let nliChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nliFetch(url) {
  const job = nliChain.then(async () => {
    for (const wait of [0, 2000, 6000]) {
      if (wait) await sleep(wait);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      noteResponse(res);
      if (res?.ok) return res.text();
      if (res && res.status < 500 && res.status !== 429) return null;
    }
    return null;
  });
  nliChain = job.then(() => sleep(1500), () => sleep(1500));
  return job;
}

const xmlDecode = (v) => v.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// [[code, value], …] for each field with this tag.
export function marcFields(xml, tag) {
  const re = new RegExp(`tag="${tag}"[^>]*>([\\s\\S]*?)</(?:\\w+:)?datafield>`, 'g');
  return [...xml.matchAll(re)].map((m) => [...m[1].matchAll(/code="(\w)">([^<]*)</g)].map(([, c, v]) => [c, xmlDecode(v)]));
}
const sub = (f, code) => f.find(([c]) => c === code)?.[1] ?? null;
const control = (xml, tag) => xml.match(new RegExp(`<controlfield tag="${tag}">([^<]*)<`))?.[1] ?? '';

// MARC XML records for a CQL query ("alma.isbn=…", "alma.title=\"…\"").
export async function nliRecords(cql, max = 10) {
  const xml = await nliFetch(`${SRU}?version=1.2&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=${max}&query=${encodeURIComponent(cql)}`);
  if (!xml) return [];
  return [...xml.matchAll(/<record xmlns="http:\/\/www\.loc\.gov\/MARC21\/slim">([\s\S]*?)<\/record>/g)].map((m) => m[1]);
}

// "עוז, עמוס, 1939-2018" → "עמוס עוז"
function nliAuthor(a) {
  const name = a.replace(/[,.]?\s*\d{4}-(\d{4})?\.?/, '').replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+(מחבר|מחברת|author|editor|עורך|עורכת)\.?\s*$/i, '').replace(/[.,\s]+$/, '').trim();
  const [last, first, ...rest] = name.split(/,\s*/);
  return first && !rest.length ? `${first} ${last}` : name;
}
const NOT_AUTHOR = /עורך|עורכת|עריכה|מתרגם|מתרגמת|תרגום|מאייר|מאיירת|איור|צלם|editor|translator|illustrator|photographer/i;

// One MARC record → a book, or null for things that are not books.
export function bookFromMarc(xml) {
  const leader = xml.match(/<leader>([^<]*)</)?.[1] ?? '';
  if (!/^.{6}[at][am]/.test(leader)) return null; // language material, monograph
  const t = marcFields(xml, '245')[0];
  if (!t) return null;
  const clean = (v) => (v ?? '').replace(/[\s/:;,.=]+$/, '').trim();
  const bare = clean(sub(t, 'a'));
  const title = [bare, clean(sub(t, 'b'))].filter(Boolean).join(' : ');
  // Authors: the main entry (100), and added names (700) marked as authors or named in the
  // first part of the credit line ("מנחם משגב, שרגא וקסלר ; עריכה: …"); translators, editors
  // and illustrators come after the ";" and often have no role code.
  const credit = normTitle(String(sub(t, 'c') ?? '').split(/\s;\s|;/)[0]);
  const named = (f) => { const n = normTitle(nliAuthor(sub(f, 'a'))); return n && credit.includes(n); };
  const people = [...marcFields(xml, '100'), ...marcFields(xml, '700').filter((f) => /מחבר|author/i.test(sub(f, 'e') ?? '') || (!sub(f, 'e') && named(f)))]
    .filter((f) => sub(f, 'a') && !NOT_AUTHOR.test(sub(f, 'e') ?? ''));
  const heb = people.filter((f) => sub(f, '9') === 'heb' || /[א-ת]/.test(sub(f, 'a')));
  const authors = [...new Set((heb.length ? heb : people).map((f) => nliAuthor(sub(f, 'a'))).filter(Boolean))];
  const pub = marcFields(xml, '264')[0] ?? marcFields(xml, '260')[0];
  const f008 = control(xml, '008');
  const year = Number(String(pub && sub(pub, 'c') || '').match(/\d{4}/)?.[0] || f008.slice(7, 11).match(/^\d{4}$/)?.[0]) || null;
  const isbns = marcFields(xml, '020').map((f) => normalizeIsbn(String(sub(f, 'a') ?? '').replace(/\(.*\)/, ''))).filter(Boolean);
  return {
    title,
    bare,
    authors,
    publisher: pub ? clean(sub(pub, 'b')).replace(/^\[|\]$/g, '') || null : null,
    year,
    language: sub(marcFields(xml, '041')[0] ?? [], 'a') ?? (f008.slice(35, 38).trim() || null),
    cover_url: null,
    isbn: isbns[0] ?? null,
    isbns,
    source: 'nli',
    source_ids: { nli: control(xml, '001') },
  };
}

async function nliSearch(cql) {
  return (await nliRecords(cql)).map(bookFromMarc).filter(Boolean);
}

async function fromNli(isbn) {
  const hit = (await nliSearch(`alma.isbn=${isbn}`)).find((b) => !b.isbns.length || b.isbns.includes(isbn));
  if (!hit) return null;
  const { isbn: _, isbns: __, ...meta } = hit;
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

const plainLatin = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[ʻʼʾʿ]/g, '');
// Consonant outline of a name in either script, to tell whether a Hebrew name is the same
// person as a romanized one: "Ḳisner" and "קיסנר" both give "ksnr"; "Kwik" and "קוויק" do not.
const HEB_SKEL = { ב: 'b', ג: 'g', ד: 'd', ז: 'z', ט: 't', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's', פ: 'p', ף: 'p', צ: 's', ץ: 's', ק: 'k', ר: 'r', ש: 's', ת: 't' };
function skeleton(name) {
  if (isHebrew(name)) return [...name].map((c) => HEB_SKEL[c] ?? '').join('');
  return name.toLowerCase().replace(/ṿ/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/kh|ch|ck|c|q/g, 'k').replace(/sh|ts|tz|x/g, 's').replace(/ph|f/g, 'p').replace(/[vw]/g, 'b').replace(/j/g, 'g')
    .replace(/[^bdgklmnprstz]/g, '');
}
const outline = (name) => skeleton(name).replace(/(.)\1+/g, '$1'); // "Reilly" = "ריילי"
// Same person when the whole names, or one word of each (3+ consonants: "Baumel-Schwartz" /
// "באומל"), have the same outline; ב/v/ו are ambiguous, so outlines are also compared without b.
const variants = (o) => [o, o.replace(/b/g, '')];
const samePerson = (romanized, hebrew) => {
  const same = (x, y, min) => variants(x).some((v) => v.length >= min && variants(y).includes(v));
  if (same(outline(romanized), outline(hebrew), 3)) return true;
  const words = (n) => n.split(/[\s,-]+/).map(outline).filter((o) => o.length >= 3);
  return words(romanized).some((x) => words(hebrew).some((y) => same(x, y, 3)));
};

// Hebrew books from Library of Congress style records (Open Library) carry romanized names
// ("Menaḥem Miśgav") and often a romanized subtitle ("מה לאכול: ekh li-veḥor mazon…").
// The National Library's record of the same book gives them in Hebrew: found by ISBN, or by
// the exact title when one of its authors is the same person (same consonants).
const mainOf = (t) => t.split(/\s+[:/]\s+|\s*:\s*/)[0].trim();
// "מה לאכול: ekh li-veḥor…" → true: a Hebrew title whose subtitle is written in Latin letters.
export const romanizedTail = (t) => {
  const i = t.search(/\s*[:/]\s/);
  if (i < 0 || !isHebrew(t.slice(0, i))) return false;
  const tail = t.slice(i).replace(/^[\s:/]+/, '');
  return /[a-z]{2}/i.test(tail) && !/[\u0590-\u05FF]/.test(tail);
};
async function nliTwin(b, authors) {
  try {
    if (b.isbn13) {
      const r = (await nliSearch(`alma.isbn=${b.isbn13}`)).find((x) => isHebrew(x.title));
      if (r) return r;
    }
    if (!authors.length) return null;
    const bare = mainOf(b.title);
    return (await nliSearch(`alma.title="${bare.replace(/["\\]/g, ' ')}"`)).find((r) => normTitle(r.bare) === normTitle(bare)
      && r.authors.some(isHebrew) && authors.some((a) => r.authors.some((h) => samePerson(a, h)))) ?? null;
  } catch { return null; } // the catalogue is a nicety here
}
// { title, authors } in Hebrew where the National Library has them. A romanized subtitle
// is replaced by the library's Hebrew one, or dropped (the main title alone).
export async function hebrewTitleAuthors(b) {
  const authors = b.authors ?? [];
  if (!isHebrew(b.title)) return { title: b.title, authors };
  const romanTitle = romanizedTail(b.title);
  const romanAuthors = authors.length > 0 && !authors.every(isHebrew);
  if (!romanTitle && !romanAuthors) return { title: b.title, authors };
  const rec = await nliTwin(b, authors);
  let title = b.title;
  if (romanTitle) {
    const full = rec && rec.title.replace(/\s+:\s+/, ': ');
    title = full && !/[a-z]{2}/i.test(full) && normTitle(mainOf(full)) === normTitle(mainOf(b.title)) ? full : mainOf(b.title);
  }
  return {
    title,
    authors: !romanAuthors ? authors : rec?.authors.some(isHebrew) ? rec.authors : authors.map((a) => (isHebrew(a) ? a : plainLatin(a))),
  };
}
export async function hebrewAuthors(b) {
  return (await hebrewTitleAuthors(b)).authors;
}

export async function upsertBook(b) {
  b = { ...b, ...(await hebrewTitleAuthors(b)) };
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
    // A misread author name hides good matches; try the title alone, but still never take a
    // book by someone else (on 6 Nov 2026 a third of the declined shelf books were a same-title
    // book by another author: "משוואה עם נעלם" by אורי אדלמן matched a 2005 study).
    return r.book || !author ? r : searchTitle(title, null, verify, author);
  });
}

// Books already here (some added by readers, found in no catalogue).
async function appTitleCandidates(title) {
  const q = normTitle(title);
  if (q.length < 3) return [];
  return many(`SELECT * FROM books WHERE $1 <% search ORDER BY word_similarity($1, search) DESC, isbn13 IS NULL LIMIT 10`, [q]).catch(() => []);
}

async function searchTitle(title, author, verify, veto = author) {
  const mine = [];
  for (const b of await appTitleCandidates(title)) mine.push({ ...b, bare: b.title, alt: null, via: 'app', book: b });
  const here = pickBest(mine, title, author, verify, veto);
  if (here) return { book: here.book, source: 'app', score: here.score };
  const candidates = [];
  for (const r of await track('local_ol', () => localTitleCandidates(title)).catch(() => [])) {
    candidates.push({ ...fromLocal(r), bare: r.title, isbn: r.isbn13, alt: r.tnorm, via: 'local_ol' });
  }
  const local = pickBest(candidates, title, author, verify, veto);
  if (local) return { book: await saveCandidate(local, title), source: local.via, score: local.score };
  // Hebrew titles: the National Library has nearly every Israeli book.
  if (isHebrew(title)) {
    try {
      for (const b of await track('nli', () => nliSearch(`alma.title="${title.replace(/["\\]/g, ' ')}"`)) ?? []) candidates.push({ ...b, via: 'nli' });
    } catch { /* fall through to Google Books */ }
  }
  const q = [`intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join(' ');
  if (!pickBest(candidates, title, author, verify, veto)) try {
    const gb = await track('googlebooks', () => getJson(gbUrl(`maxResults=5&q=${encodeURIComponent(q)}`)), (r) => r?.items?.length ?? 0);
    for (const item of gb?.items ?? []) {
      const v = item.volumeInfo;
      const isbn = v.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier;
      candidates.push({ title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title, bare: v.title, authors: v.authors ?? [], isbn,
        publisher: v.publisher ?? null, year: Number(String(v.publishedDate ?? '').slice(0, 4)) || null, language: v.language ?? null,
        cover_url: v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') ?? null, source: 'googlebooks', source_ids: { googlebooks: item.id }, via: 'googlebooks' });
    }
  } catch { /* try Open Library */ }
  if (!pickBest(candidates, title, author, verify, veto)) {
    try {
      const ol = await track('openlibrary', () => getJson(`https://openlibrary.org/search.json?limit=5&fields=key,title,author_name,isbn,first_publish_year,cover_i&title=${encodeURIComponent(title)}${author ? `&author=${encodeURIComponent(author)}` : ''}`), (r) => r?.docs?.length ?? 0);
      for (const d of ol?.docs ?? []) {
        candidates.push({ title: d.title, bare: d.title, authors: d.author_name ?? [], isbn: d.isbn?.find((i) => i.length === 13),
          publisher: null, year: d.first_publish_year ?? null, language: null,
          cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null, source: 'openlibrary', source_ids: { openlibrary: d.key }, via: 'openlibrary' });
      }
    } catch { /* no match */ }
  }
  const best = pickBest(candidates, title, author, verify, veto);
  // On a miss, keep the closest score anyway: it helps tune the 0.7 threshold.
  return best ? { book: await saveCandidate(best, title), source: best.via, score: best.score }
    : { book: null, score: rankBest(candidates, title, author, verify, veto).score || null };
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

function pickBest(candidates, title, author, verify, veto = author) {
  const { best, score } = rankBest(candidates, title, author, verify, veto);
  return best && score >= 0.7 ? { ...best, score } : null;
}

const mainTitle = (s) => String(s ?? '').split(':')[0];

// How alike a name read off a spine is to a record's author: words, or letters for a
// misread ("קמילא בנקו" / "קמילה בנקו"); across scripts, the same consonants.
function authorCloseness(read, name) {
  if (isHebrew(read) !== isHebrew(name)) return isHebrew(read) ? (samePerson(name, read) ? 1 : 0) : (samePerson(read, name) ? 1 : 0);
  return Math.max(similarity(read, name), charSimilarity(read, name));
}
// The record is by someone else: it names authors and none is like the one read (unless
// what was read as the author is really the title, the two read the wrong way round).
export function otherAuthor(read, c) {
  if (!read || !c.authors?.length) return false;
  if (Math.max(...c.authors.map((a) => authorCloseness(read, a))) >= 0.35) return false;
  return Math.max(similarity(read, c.title ?? ''), charSimilarity(read, c.title ?? '')) < 0.5;
}

function rankBest(candidates, title, author, verify, veto = author) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (verify && !verify(c)) continue;
    if (otherAuthor(veto, c)) continue;
    const chars = Math.max(charSimilarity(title, c.title), charSimilarity(title, c.bare));
    // Alternative titles hold the Hebrew of romanized records; a read title found inside
    // them counts only as far as it covers the record's main title (a word or two read
    // off a spine is inside many long titles).
    const alt = c.alt && !isHebrew(c.title) ? containment(title, c.alt) * Math.min(1, words(title).size / (words(mainTitle(c.bare)).size || 1)) : 0;
    let score = Math.max(similarity(title, c.title), similarity(title, c.bare), similarity(title, mainTitle(c.bare)), alt,
      chars >= 0.9 ? chars * 0.8 : 0);
    // Prefer records in the script we read (the Hebrew edition over translations).
    if (isHebrew(title) !== isHebrew(c.title)) score *= 0.9;
    if (author && c.authors.length) score = score * 0.75 + 0.25 * Math.max(...c.authors.map((a) => authorCloseness(author, a)));
    // A record naming no author loses a tie to one naming the author we read, and needs
    // nearly the whole title ("MR NICE 2" by Howard Marks is not "Mr. Nice Spy").
    else if (author) { if (score < 0.85) continue; score *= 0.95; }
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
