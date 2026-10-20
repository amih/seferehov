// What a book looks like and what its back cover says, for the book page: a large
// front cover, the back cover when one is online, and the blurb. Looked up the first
// time someone opens the book, cached on the books row, looked up again after a month.
//
// Hebrew books: the National Library (by ISBN; the only source with back covers, for
// books it photographed), then Simania (by title and author). Others: Open Library,
// then Amazon for the front cover. Cover pictures are copied to our own uploads.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { one, q } from './db.js';
import { normTitle } from './vision.js';
import { normalizeDanacode } from './util.js';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36 Seferehov/0.1 (+https://seferehov.com)';
const REFRESH_DAYS = 30;
const inFlight = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = 'json', tries = [0]) {
  for (const wait of tries) {
    if (wait) await sleep(wait);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    if (res?.ok) return as === 'json' ? res.json().catch(() => null) : as === 'text' ? res.text() : Buffer.from(await res.arrayBuffer());
    if (res && res.status < 500 && res.status !== 429) return null;
  }
  return null;
}

// api.nli.org.il answers 502 to bursts: one call at a time, spaced, with retries.
let nliChain = Promise.resolve();
function nli(url, as) {
  const job = nliChain.then(() => get(url, as, [0, 3000, 8000]));
  nliChain = job.then(() => sleep(1500), () => sleep(1500));
  return job;
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Source notes at the end of a blurb: "--back cover", "-- מהכריכה האחורית".
const tidy = (v) => (v ? decode(String(v)).replace(/\s*\r?\n?\s*-{2,}\s*[^\n]{0,60}$/, '').trim() || null : null);

function isbn10(isbn13) {
  if (!/^978\d{10}$/.test(isbn13 ?? '')) return null;
  const b = isbn13.slice(3, 12);
  const c = (11 - ([...b].reduce((a, d, i) => a + Number(d) * (10 - i), 0) % 11)) % 11;
  return b + (c === 10 ? 'X' : c);
}

const DC = 'http://purl.org/dc/elements/1.1/';
function marcFields(xml, tag) {
  const re = new RegExp(`tag="${tag}"[^>]*>([\\s\\S]*?)</(?:\\w+:)?datafield>`, 'g');
  return [...xml.matchAll(re)].map((m) => [...m[1].matchAll(/code="(\w)">([^<]*)</g)].map(([, c, v]) => [c, decode(v)]));
}
async function iiifImage(repId) {
  const man = await get(`https://nli.alma.exlibrisgroup.com/view/iiif/presentation/972NNL_INST/${repId}/manifest`);
  const svc = man?.items?.[0]?.items?.[0]?.items?.[0]?.body?.service?.[0]?.id;
  return svc ? `${svc}/full/1200,/0/default.jpg` : null;
}

// National Library of Israel: search by ISBN (older records hold only the ISBN-10), check
// the record really lists it (MARC 020), blurb from 520, front/back photos from AVD.
async function fromNli(book) {
  if (!process.env.NLI_API_KEY || !book.isbn13) return null;
  for (const q of [book.isbn13, isbn10(book.isbn13)].filter(Boolean)) {
    const hits = await nli(`https://api.nli.org.il/openlibrary/search?api_key=${encodeURIComponent(process.env.NLI_API_KEY)}`
      + `&query=${encodeURIComponent(`any,contains,${q}`)}&output_format=json&limit=5`);
    const ids = (Array.isArray(hits) ? hits : [])
      .filter((it) => (it[DC + 'type'] ?? []).some((v) => v['@value'] === 'book'))
      .map((it) => it[DC + 'recordid']?.[0]?.['@value']).filter(Boolean);
    for (const rid of ids) {
      const xml = await get(`https://iiif.nli.org.il/IIIFv21/marc/bib/${rid}`, 'text');
      if (!xml) continue;
      if (!marcFields(xml, '020').flat().some(([, v]) => v.replace(/[^\dX]/gi, '') === q)) continue;
      const blurb = marcFields(xml, '520').map((f) => f.filter(([c]) => c === 'a').map(([, v]) => v).join(' ')).join('\n\n');
      let front = null, back = null;
      for (const f of marcFields(xml, 'AVD')) {
        const vals = f.map(([, v]) => v);
        const label = vals.find((v) => /קדמית|אחורית|_FRONT|_BACK/i.test(v)) ?? '';
        if (/אחורית|_BACK/i.test(label)) back ??= vals[1]; else if (/קדמית|_FRONT/i.test(label)) front ??= vals[1];
      }
      // The record also holds the book's Danacode (024 $2 danacode): kept, so a later
      // scan of the Danacode barcode finds this book.
      const dana = marcFields(xml, '024').find((f) => f.some(([c, v]) => c === '2' && /danacode/i.test(v)))?.find(([c]) => c === 'a')?.[1];
      return { source: 'nli', danacode: normalizeDanacode(dana), description: tidy(blurb), front_url: front && await iiifImage(front), back_url: back && await iiifImage(back) };
    }
  }
  return null;
}

// Simania: no ISBN search, so title + author, and only when its title matches ours.
async function fromSimania(book) {
  const title = book.title.split(/[:/]/)[0].trim();
  const d = await get(`https://simania.co.il/api/search?query=${encodeURIComponent(`${title} ${book.authors?.[0] ?? ''}`.trim())}&page=1`);
  const want = normTitle(title);
  const b = (d?.data?.books ?? []).find((x) => {
    const got = normTitle(x.NAME);
    return got && want && (got === want || (Math.min(got.length, want.length) >= 4 && (got.includes(want) || want.includes(got))));
  });
  if (!b) return null;
  return { source: 'simania', front_url: Number(b.hasImage) ? b.COVER : null, back_url: null, description: tidy(b.DESCRIPTION) };
}

const text = (d) => tidy(typeof d === 'string' ? d : d?.value);
async function fromOpenLibrary(book) {
  const workKey = book.source_ids?.openlibrary?.startsWith('/works/') ? book.source_ids.openlibrary : null;
  const ed = book.isbn13 ? await get(`https://openlibrary.org/isbn/${book.isbn13}.json`) : null;
  const wk = ed?.works?.[0]?.key ?? workKey;
  const work = wk ? await get(`https://openlibrary.org${wk}.json`) : null;
  if (!ed && !work) return null;
  const cover = ed?.covers?.find((c) => c > 0) ?? work?.covers?.find((c) => c > 0);
  return {
    source: 'openlibrary',
    front_url: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : null,
    back_url: null,
    description: text(ed?.description) ?? text(work?.description),
  };
}

// Amazon's image server, front cover only; a miss is a 1×1 GIF.
async function fromAmazon(book) {
  const i10 = isbn10(book.isbn13);
  return i10 ? { source: 'amazon', front_url: `https://images-na.ssl-images-amazon.com/images/P/${i10}.01._SCLZZZZZZZ_.jpg`, back_url: null, description: null } : null;
}

const isHebrew = (book) => book.isbn13?.startsWith('978965') || /[֐-׿]/.test(book.title);

// Copies a cover to our uploads (no hotlinking; resized). Null when it is not a real picture.
async function keep(url, bookId, side) {
  if (!url) return null;
  const buf = await get(url, 'buffer');
  if (!buf || buf.length < 2000) return null;
  try {
    const { width } = await sharp(buf).metadata();
    if (!width || width < 80) return null;
    const rel = `covers/${bookId}-${side}.webp`;
    await mkdir(join(config.uploadDir, 'covers'), { recursive: true });
    await sharp(buf).rotate().resize(1200, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(join(config.uploadDir, rel));
    return `/uploads/${rel}?v=${Date.now().toString(36)}`;
  } catch { return null; }
}

async function lookUp(book) {
  const sources = isHebrew(book) ? [fromNli, fromSimania, fromOpenLibrary] : [fromOpenLibrary, fromAmazon, fromSimania];
  const found = { front_url: null, back_url: null, description: null, sources: [] };
  for (const src of sources) {
    let r = null;
    try { r = await src(book); } catch { /* next source */ }
    if (!r) continue;
    let used = false;
    for (const side of ['front_url', 'back_url']) {
      if (found[side] || !r[side]) continue;
      found[side] = await keep(r[side], book.id, side === 'front_url' ? 'front' : 'back');
      used ||= !!found[side];
    }
    if (!found.description && r.description) { found.description = r.description; used = true; }
    if (r.danacode && !book.danacode) {
      await q('UPDATE books SET danacode = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM books WHERE danacode = $2)', [book.id, r.danacode]).catch(() => {});
    }
    if (used) found.sources.push(r.source);
    if (found.front_url && found.back_url && found.description) break;
  }
  return one(
    `UPDATE books SET front_url = $2, back_url = $3, details_source = $5, details_at = now(),
            description = CASE WHEN 'description' = ANY(fixed_fields) THEN description ELSE $4 END
      WHERE id = $1 RETURNING *`,
    [book.id, found.front_url, found.back_url, found.description?.slice(0, 4000) ?? null, found.sources.join(', ') || null],
  );
}

export async function bookDetails(book) {
  if (book.details_at && Date.now() - new Date(book.details_at) < REFRESH_DAYS * 86400_000) return book;
  if (!inFlight.has(book.id)) inFlight.set(book.id, lookUp(book).finally(() => inFlight.delete(book.id)));
  return inFlight.get(book.id);
}

// What a found book still lacks that a reader can photograph: 'front' and/or 'back'.
// Waits briefly for the first details lookup; covers readers took count too.
export async function missingParts(book) {
  const b = await Promise.race([bookDetails(book).catch(() => null), sleep(2500).then(() => null)]) ?? book;
  const own = await one(
    `SELECT bool_or(photo_id IS NOT NULL) AS front, bool_or(back_photo_id IS NOT NULL) AS back FROM (
       SELECT photo_id, back_photo_id FROM sightings WHERE book_id = $1
       UNION ALL SELECT photo_id, back_photo_id FROM my_books WHERE book_id = $1) x`,
    [book.id],
  );
  return [!(b.front_url || b.cover_url || own?.front) && 'front', !(b.back_url || own?.back) && 'back'].filter(Boolean);
}
