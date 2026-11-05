// Fills the local title / author index (ref_titles, ref_authors; see migration 040) from
// free, reusable sources. Each source is replaced as a whole, in one transaction.
//   node --env-file=../.env scripts/import-refs.js wikidata
//   node --env-file=../.env scripts/import-refs.js hewiki <hewiki-…-pages-articles.xml.bz2>
//   node --env-file=../.env scripts/import-refs.js benyehuda
// Sources and terms: Wikidata (CC0, via the QLever endpoint, which answers large queries),
// Hebrew Wikipedia (CC BY-SA: titles and names only, with the page as `ref`),
// Project Ben-Yehuda catalogue (public domain; its entries are mostly poems and articles,
// so only the author names are taken).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tx } from '../src/db.js';

const UA = 'Seferehov/0.1 (https://seferehov.com; book title index)';
const [mode, file] = process.argv.slice(2);

// --- writing -------------------------------------------------------------------------
async function replace(source, titles, authors) {
  const uniq = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];
  titles = uniq(titles.filter((r) => r.title && r.title.length >= 2 && r.title.length <= 150), (r) => `${r.title}\t${r.author ?? ''}`);
  authors = uniq(authors.filter((r) => r.name && r.name.length >= 3 && r.name.length <= 80), (r) => r.name);
  await tx(async (db) => {
    await db.query('DELETE FROM ref_titles WHERE source = $1', [source]);
    await db.query('DELETE FROM ref_authors WHERE source = $1', [source]);
    for (let i = 0; i < titles.length; i += 5000) {
      const b = titles.slice(i, i + 5000);
      await db.query(
        `INSERT INTO ref_titles(title, author, year, source, ref, title_f, author_f)
         SELECT t, a, y, $5, r, heb_fold(t), heb_fold(a) FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS x(t, a, y, r)`,
        [b.map((r) => r.title), b.map((r) => r.author ?? null), b.map((r) => r.year ?? null), b.map((r) => r.ref ?? null), source]);
    }
    for (let i = 0; i < authors.length; i += 5000) {
      const b = authors.slice(i, i + 5000);
      await db.query(
        `INSERT INTO ref_authors(name, source, ref, name_f) SELECT n, $3, r, heb_fold(n) FROM unnest($1::text[], $2::text[]) AS x(n, r)`,
        [b.map((r) => r.name), b.map((r) => r.ref ?? null), source]);
    }
  });
  console.log(`${source}: ${titles.length} titles, ${authors.length} names`);
}

// --- Wikidata ------------------------------------------------------------------------
const PREFIX = `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>`;
async function sparql(query) {
  let res;
  // A shared public endpoint: on "too many requests" wait 1, 2, 4, 8 minutes.
  for (const wait of [0, 60, 120, 240, 480]) {
    if (wait) { console.error(`qlever busy, waiting ${wait} s`); await new Promise((r) => setTimeout(r, wait * 1000)); }
    res = await fetch('https://qlever.dev/api/wikidata', { method: 'POST', body: new URLSearchParams({ query: `${PREFIX} ${query}` }),
      headers: { Accept: 'text/tab-separated-values', 'User-Agent': UA }, signal: AbortSignal.timeout(600_000) });
    if (res.status !== 429 && res.status < 500) break;
  }
  if (!res.ok) throw new Error(`qlever ${res.status}`);
  const [head, ...lines] = (await res.text()).split('\n').filter(Boolean);
  const cols = head.split('\t').map((c) => c.replace(/^\?/, ''));
  // Literals come as "text"@he, IRIs as <http://www.wikidata.org/entity/Q1>.
  const val = (v) => (v ?? '').replace(/^"(.*)"(@[\w-]+|\^\^.*)?$/s, '$1').replace(/^<http:\/\/www\.wikidata\.org\/entity\/(Q\d+)>$/, '$1').replace(/\\"/g, '"');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], val(v)])));
}

async function wikidata() {
  // Written works (books, novels, poetry collections, plays…) with a Hebrew title.
  const works = await sparql(`SELECT ?b ?l (SAMPLE(?al) AS ?author) (MIN(YEAR(?d)) AS ?y) WHERE {
    ?b wdt:P31/wdt:P279* wd:Q47461344 . ?b rdfs:label ?l FILTER(LANG(?l) = "he")
    FILTER NOT EXISTS { ?b wdt:P31 wd:Q13442814 }
    OPTIONAL { ?b wdt:P50 ?a . ?a rdfs:label ?al FILTER(LANG(?al) = "he") }
    OPTIONAL { ?b wdt:P577 ?d } } GROUP BY ?b ?l`);
  await new Promise((r) => setTimeout(r, 10_000));
  // People who write: in the National Library's name file, author of a work, or writer / poet / novelist.
  const people = await sparql(`SELECT ?p ?l WHERE { ?p wdt:P31 wd:Q5 .
    { ?p rdfs:label ?l } UNION { ?p skos:altLabel ?l } FILTER(LANG(?l) = "he")
    { ?p wdt:P8189 ?x } UNION { ?w wdt:P50 ?p } UNION { ?p wdt:P106 wd:Q36180 } UNION { ?p wdt:P106 wd:Q6625963 } UNION { ?p wdt:P106 wd:Q49757 } }`);
  await replace('wikidata',
    works.map((w) => ({ title: w.l, author: w.author || null, year: Number(w.y) || null, ref: w.b })),
    people.map((p) => ({ name: p.l, ref: p.p })));
}

// --- Hebrew Wikipedia ----------------------------------------------------------------
// Bibliography sections of writers' pages ("ספריו", "ביבליוגרפיה"…: bulleted lines or a
// table whose first column is the title) and book pages with the "ספר" infobox.
const BIB = /^(ספריו|ספריה|ספרים|ספרים שכתב|ספרים שכתבה|מספריו|מספריה|ביבליוגרפיה|רשימת ספריו|רשימת ספריה|יצירותיו|יצירותיה|כתביו|כתביה|ספרי פרוזה|ספרי שירה|ספרי ילדים|ספרי עיון|פרוזה|שירה|רומנים|ספרות ילדים|ספרי נוער|ספריו שתורגמו לעברית|ספריה שתורגמו לעברית|ספריו בעברית|ספריה בעברית|יצירות|ספריו המתורגמים לעברית|ספרים שתורגמו לעברית)(?![\p{L}])/u;
const WRITER_BOX = /\{\{\s*(סופר|משורר|משוררת|סופרת|מחזאי|אישיות ספרותית)\s*[|\n}]/;
const BOOK_BOX = /\{\{\s*(ספר|ספר קומיקס)\s*\n?\s*\|/;
const page = (t) => t.replace(/\s*\([^)]*\)\s*$/, '').trim();

function unwiki(s) {
  let t = s;
  for (let i = 0; i < 3; i++) t = t.replace(/\{\{[^{}]*\}\}/g, ''); // templates, inner first
  return t.replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// The title in one bibliography line: bold, italic or quoted first, else the first link, else
// the text before the first comma / parenthesis.
function titleOf(line) {
  const l = line.replace(/^[*#:;\s]+/, '');
  const pick = l.match(/'''(.+?)'''/)?.[1] ?? l.match(/''(.+?)''/)?.[1] ?? l.match(/^\s*"([^"]{2,})"/)?.[1]
    ?? l.match(/^\s*\[\[([^\]]+)\]\]/)?.[1] ?? l.split(/[,(–]| - /)[0];
  const t = unwiki(pick ?? '').replace(/^["“„']+|["”']+$/g, '').replace(/[.,:;]+$/, '').trim();
  if (!t || t.length > 120 || /^\d+$/.test(t) || !/\p{L}/u.test(t)) return null;
  return t;
}
const yearOf = (line) => Number(line.match(/\b(1[89]\d\d|20[0-3]\d)\b/)?.[1]) || null;

function fromPage(title, text, out) {
  if (BOOK_BOX.test(text)) {
    const box = text.slice(text.search(BOOK_BOX), text.search(BOOK_BOX) + 3000);
    const author = unwiki(box.match(/\|\s*(?:מחבר|מחברת|כותב|סופר)\s*=\s*([^\n|]+(?:\|[^\n=]*\]\][^\n|]*)?)/)?.[1] ?? '');
    const name = unwiki(box.match(/\|\s*שם\s*=\s*([^\n|]+)/)?.[1] ?? '') || page(title);
    out.titles.push({ title: name, author: author || null, year: yearOf(box.match(/\|\s*(?:שנת הוצאה|שנה|תאריך הוצאה)\s*=\s*([^\n|]+)/)?.[1] ?? ''), ref: title });
  }
  const writer = WRITER_BOX.test(text);
  const author = page(title);
  let inBib = 0; // heading level of the current bibliography section, 0 = outside
  let inTable = false, rowStart = false;
  let found = 0;
  for (const raw of text.split('\n')) {
    const h = raw.match(/^(=+)\s*(.*?)\s*=+\s*$/);
    if (h) {
      const level = h[1].length;
      if (inBib && level <= inBib) inBib = 0;
      if (!inBib && BIB.test(h[2])) inBib = level;
      continue;
    }
    if (!inBib) continue;
    if (raw.startsWith('{|')) { inTable = true; continue; }
    if (raw.startsWith('|}')) { inTable = false; continue; }
    if (inTable) {
      if (raw.startsWith('|-')) { rowStart = true; continue; }
      if (rowStart && raw.startsWith('|') && !raw.startsWith('|+')) {
        rowStart = false;
        const cell = raw.slice(1).split('||')[0].replace(/^[^|[\]]*\|(?!\|)/, ''); // drop cell attributes
        const t = titleOf(cell);
        if (t) { out.titles.push({ title: t, author, year: yearOf(raw), ref: title }); found++; }
      }
      continue;
    }
    if (/^[*#]/.test(raw)) {
      const t = titleOf(raw);
      if (t) { out.titles.push({ title: t, author, year: yearOf(raw), ref: title }); found++; }
    } else if (raw.trim()) {
      // Running text about the works: titles in quotes ("הרומנים העיקריים שלה כוללים את "אדונית התבלינים", …").
      for (const m of unwiki(raw).matchAll(/["“„]([^"“”„]{2,60})["”]/g)) {
        const t = m[1].trim();
        const words = t.split(/\s+/).length;
        if (words <= 8 && /\p{L}/u.test(t)) { out.titles.push({ title: t, author, year: null, ref: title }); found++; }
      }
    }
  }
  if (writer || found) out.authors.push({ name: author, ref: title });
}

async function hewiki(path) {
  const out = { titles: [], authors: [] };
  const bz = spawn('bzcat', [path]);
  const rl = createInterface({ input: bz.stdout, crlfDelay: Infinity });
  let title = null, ns = null, text = null, inText = false, n = 0;
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
  for await (const line of rl) {
    if (inText) {
      const end = line.indexOf('</text>');
      text.push(end >= 0 ? line.slice(0, end) : line);
      if (end >= 0) {
        inText = false;
        if (ns === '0') fromPage(title, decode(text.join('\n')), out);
        if (++n % 100000 === 0) console.error(`${n} pages, ${out.titles.length} titles`);
      }
      continue;
    }
    const tm = line.match(/<title>(.*)<\/title>/);
    if (tm) { title = decode(tm[1]); ns = null; continue; }
    const nm = line.match(/<ns>(\d+)<\/ns>/);
    if (nm) { ns = nm[1]; continue; }
    const st = line.match(/<text[^>]*>(.*)$/);
    if (st && !line.includes('/>')) {
      const rest = st[1];
      const end = rest.indexOf('</text>');
      if (end >= 0) { if (ns === '0') fromPage(title, decode(rest.slice(0, end)), out); }
      else { inText = true; text = [rest]; }
    }
  }
  await replace('hewiki', out.titles, out.authors);
}

// --- Project Ben-Yehuda --------------------------------------------------------------
async function benyehuda() {
  const res = await fetch('https://raw.githubusercontent.com/projectbenyehuda/public_domain_dump/master/pseudocatalogue.csv', { headers: { 'User-Agent': UA } });
  const csv = await res.text();
  const names = new Map();
  // Columns: ID,path,title,authors,translators,author_uris,… — authors is the 4th field.
  for (const line of csv.split('\n').slice(1)) {
    const f = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
    for (const a of (f[3] ?? '').split(/,\s*/)) if (/[א-ת]/.test(a)) names.set(a.trim(), f[5]?.split(/\s*,\s*/)[0] || null);
  }
  await replace('benyehuda', [], [...names].map(([name, ref]) => ({ name, ref })));
}

export { fromPage, titleOf };
if (import.meta.url !== `file://${process.argv[1]}`) { /* imported (tests) */ } else if (mode === 'wikidata') await wikidata();
else if (mode === 'hewiki') await hewiki(file);
else if (mode === 'benyehuda') await benyehuda();
else { console.error('usage: import-refs.js wikidata | hewiki <dump.xml.bz2> | benyehuda'); process.exit(2); }
if (import.meta.url === `file://${process.argv[1]}`) process.exit(0);
