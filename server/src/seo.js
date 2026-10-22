// Pages for search engines. Every app URL gets index.html with its own <title>, meta,
// canonical/hreflang, JSON-LD and readable HTML inside <main>; the app replaces that HTML
// when it starts. Rendered from the live database on each request (60 s cache), so new
// libraries and book reports show up right away.
//   /             home: what Seferehov is + towns in Israel + countries
//   /places       countries
//   /c/:cc        towns in one country
//   /p/:id-:slug  one town: its libraries and the books on them
//   /l/:code      one library
//   /b/:id-:slug  one book: its covers, the text printed on them, its codes, where it is,
//                 and what readers wrote about it
//   /r/:id-:slug  one reader: the books they read, rated and recommend
// Also /robots.txt and /sitemap.xml (+ /sitemaps/*.xml).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { one, many } from './db.js';
import { escapeHtml as esc } from './util.js';
import { PRESENT_BOOKS_SQL, TAKEN_BOOKS_SQL } from './locations.js';
import { normTitle } from './vision.js';
import { BOOK_REVIEWS_SQL, READER_REVIEWS_SQL, QUESTIONS, hasText } from './reviews.js';
import { OFFERS_SQL } from './offers.js';
import { translate } from '../../web/src/i18n.js';
import { levelOf } from '../../web/src/levels.js';

const LANGS = ['he', 'en'];

// A library page is worth a search engine's time only once there is something of its own on
// it: readers added, checked, edited or reported books there, or it is in Israel. The ~48k
// untouched OpenStreetMap shelves abroad all read the same, so they get noindex and stay out
// of the sitemap (Google folded them together as duplicates).
const LIB_INDEXED = `(l.source = 'user' OR l.last_checked_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM sightings s WHERE s.location_id = l.id AND s.status = 'approved')
  OR EXISTS (SELECT 1 FROM location_checks c WHERE c.location_id = l.id)
  OR EXISTS (SELECT 1 FROM location_edits e WHERE e.location_id = l.id AND e.status = 'approved')
  OR l.place_id IN (SELECT id FROM places WHERE country = 'IL'))`;
const SITEMAP_CHUNK = 40000;
const CACHE_MS = 60_000;

// ---- index.html from the web build, re-read after a deploy
let shell = { mtime: 0, html: '' };
function indexHtml() {
  const file = join(config.webDist, 'index.html');
  const { mtimeMs } = statSync(file);
  if (mtimeMs !== shell.mtime) shell = { mtime: mtimeMs, html: readFileSync(file, 'utf8') };
  return shell.html;
}

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

// A page changed (a review was written): drop its cached copies, in both languages.
export function forgetPages(path) {
  for (const key of cache.keys()) {
    const p = key.slice(2);
    if (p === path || p.startsWith(`${path}-`)) cache.delete(key);
  }
}

const countryName = (cc, lng) => {
  try { return new Intl.DisplayNames([lng], { type: 'region' }).of(cc) ?? cc; } catch { return cc; }
};
const placeName = (p, lng) => (lng === 'he' && p.name_he) || p.name;
const placePath = (p) => `/p/${p.id}-${p.slug}`;
const withLang = (path, lng) => (lng === 'he' ? path : `${path}?lang=en`);
const fmtDate = (d, lng) => new Date(d).toLocaleDateString(lng === 'he' ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Latest report per (library, book); a book is "on the shelf" if that report is seen/added.
const PRESENT_CTE = `present AS (
  SELECT * FROM (
    SELECT DISTINCT ON (s.location_id, s.book_id) s.location_id, s.book_id, s.kind, s.created_at
      FROM sightings s
     WHERE s.status = 'approved' AND s.location_id = ANY($1)
     ORDER BY s.location_id, s.book_id, s.created_at DESC) x
   WHERE kind IN ('seen', 'added'))`;

function libList(libs, T, lng) {
  return `<ul>${libs.map((l) => `<li><a href="${withLang(`/l/${l.code}`, lng)}">${esc(l.name || T('free_library'))}</a>${
    l.books ? ` — ${T('seo.n_books', { n: l.books })}` : ''}</li>`).join('')}</ul>`;
}
// A book's own page: /b/<id>-<title words> (Hebrew letters kept; the words are ignored).
export const bookSlug = (title) => normTitle(title).split(' ').filter(Boolean).slice(0, 8).join('-').slice(0, 80);
export const readerPath = (u) => `/r/${u.id}${bookSlug(u.screen_name) ? `-${encodeURIComponent(bookSlug(u.screen_name))}` : ''}`;
const stars = (n) => (n ? `<span class="stars" aria-label="${n}/5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>` : '');
// One review: the stars, then each guided question the reader answered, with the question.
function reviewHtml(r, T, lng, { who = true } = {}) {
  const a = r.answers ?? {};
  return `<article class="review">
    <p class="review-head">${who ? `<a href="${withLang(readerPath({ id: r.user_id, screen_name: r.screen_name }), lng)}">${esc(r.screen_name)}</a> ` : ''}${stars(r.rating)}
      <span class="muted small">${hasText(a) ? '' : `${T('review.read_it_short')} · `}${fmtDate(r.updated_at, lng)}</span></p>
    ${QUESTIONS.filter((k) => a[k]).map((k) => `<p><span class="q">${T(`review.q_${k}`)}</span><br><bdi dir="auto">${esc(a[k]).replace(/\n/g, '<br>')}</bdi></p>`).join('')}
  </article>`;
}
const reviewBody = (a) => QUESTIONS.filter((k) => a?.[k]).map((k) => a[k]).join('\n\n');
export const bookPath = (b) => `/b/${b.id}${bookSlug(b.title) ? `-${encodeURIComponent(bookSlug(b.title))}` : ''}`;
function bookList(books, lng = 'he') {
  return `<ul>${books.map((b) => {
    const href = b.id ? withLang(bookPath(b), lng) : b.code ? `/l/${b.code}` : null;
    return `<li>${href ? `<a href="${href}">` : ''}<strong>${esc(b.title)}</strong>${href ? '</a>' : ''}${
      b.authors?.length ? ` — ${esc(b.authors.join(', '))}` : ''}${b.year ? ` (${b.year})` : ''}</li>`;
  }).join('')}</ul>`;
}
function placeLinks(places, T, lng) {
  return `<ul class="place-links">${places.map((p) => `<li><a href="${withLang(placePath(p), lng)}">${esc(placeName(p, lng))}</a> (${T('seo.n_libs', { n: p.n })})</li>`).join('')}</ul>`;
}
const breadcrumbs = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: config.baseUrl + path })),
});

// ---- page renderers: each returns { title, description, html, jsonld } or null (404)

async function homePage(lng, T) {
  const il = await many(
    `SELECT p.id, p.slug, p.name, p.name_he, count(*)::int AS n
       FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' AND p.country = 'IL'
      GROUP BY p.id ORDER BY n DESC, p.population DESC`);
  const countries = await countryCounts();
  return {
    title: T('seo.home_title'),
    description: T('seo.home_desc'),
    html: `<h1>${T('seo.home_h1')}</h1><p>${T('seo.home_lead')}</p>
      <p>${T('shelves.note_html')}</p>
      <h2>${T('seo.israel')}</h2>${placeLinks(il, T, lng)}
      <h2>${T('seo.world')}</h2>${countryLinks(countries.slice(0, 30), T, lng)}
      <p><a href="${withLang('/places', lng)}">${T('seo.all_countries')}</a></p>`,
    jsonld: [{
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: T('app.name'),
      alternateName: ['ספרחוב', 'Seferehov', 'ספר רחוב'],
      url: config.baseUrl + '/',
      inLanguage: lng,
      description: T('seo.home_desc'),
      publisher: { '@type': 'Person', name: 'Ami Heines', email: 'ami@seferehov.com' },
    }],
  };
}

function countryCounts() {
  return cached('countries', () => many(
    `SELECT p.country AS cc, count(*)::int AS n, count(DISTINCT p.id)::int AS places
       FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' GROUP BY p.country ORDER BY n DESC`));
}
function countryLinks(rows, T, lng) {
  return `<ul class="place-links">${rows.map((c) => `<li><a href="${withLang(`/c/${c.cc.toLowerCase()}`, lng)}">${esc(countryName(c.cc, lng))}</a> (${T('seo.n_libs', { n: c.n })})</li>`).join('')}</ul>`;
}

async function placesPage(lng, T) {
  const rows = await countryCounts();
  const n = rows.reduce((a, c) => a + c.n, 0);
  return {
    title: T('seo.places_title'),
    description: T('seo.places_lead', { n, countries: rows.length }),
    html: `<h1>${T('seo.places_h1')}</h1><p>${T('seo.places_lead', { n, countries: rows.length })}</p>${countryLinks(rows, T, lng)}`,
    jsonld: [breadcrumbs([[T('app.name'), '/'], [T('seo.places_h1'), '/places']])],
  };
}

async function countryPage(lng, T, cc) {
  cc = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return null;
  const rows = await many(
    `SELECT p.id, p.slug, p.name, p.name_he, count(*)::int AS n, bool_or(${LIB_INDEXED}) AS indexed
       FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' AND p.country = $1
      GROUP BY p.id ORDER BY n DESC, p.population DESC LIMIT 2000`, [cc]);
  if (!rows.length) return null;
  const country = countryName(cc, lng);
  const inCountry = T('seo.in', country);
  const n = rows.reduce((a, p) => a + p.n, 0);
  return {
    title: T('seo.country_title', { inCountry }),
    description: T('seo.country_lead', { n, places: rows.length, inCountry }),
    noindex: !rows.some((p) => p.indexed),
    html: `<h1>${T('seo.country_h1', { inCountry })}</h1><p>${T('seo.country_lead', { n, places: rows.length, inCountry })}</p>${placeLinks(rows, T, lng)}`,
    jsonld: [breadcrumbs([[T('app.name'), '/'], [T('seo.places_h1'), '/places'], [country, `/c/${cc.toLowerCase()}`]])],
  };
}

async function placePage(lng, T, id) {
  const p = await one('SELECT *, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon FROM places WHERE id = $1', [id]);
  if (!p) return null;
  const libs = await many(
    `SELECT l.id, l.code, l.name, l.created_at, ${LIB_INDEXED} AS indexed,
            (SELECT max(s.created_at) FROM sightings s WHERE s.location_id = l.id AND s.status = 'approved') AS last_report
       FROM locations l WHERE l.place_id = $1 AND l.status = 'approved'
      ORDER BY l.name NULLS LAST, l.id LIMIT 500`, [id]);
  if (!libs.length) return null;
  const ids = libs.map((l) => l.id);
  const books = await many(
    `WITH ${PRESENT_CTE}
     SELECT b.id, b.title, b.authors, b.year, l.code, pr.location_id
       FROM present pr JOIN books b ON b.id = pr.book_id JOIN locations l ON l.id = pr.location_id
      ORDER BY pr.created_at DESC LIMIT 300`, [ids]);
  const perLib = new Map();
  for (const b of books) perLib.set(b.location_id, (perLib.get(b.location_id) ?? 0) + 1);
  for (const l of libs) l.books = perLib.get(l.id) ?? 0;
  libs.sort((a, b) => b.books - a.books);
  const nearby = await many(
    `SELECT p.id, p.slug, p.name, p.name_he, count(*)::int AS n
       FROM places p JOIN locations l ON l.place_id = p.id AND l.status = 'approved'
      WHERE p.id <> $1 AND ST_DWithin(p.geom, ST_MakePoint($2, $3)::geography, 40000)
      GROUP BY p.id ORDER BY min(p.geom::geometry <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)) LIMIT 12`, [id, p.lon, p.lat]);
  const name = placeName(p, lng);
  const inPlace = T('seo.in', name);
  const country = countryName(p.country, lng);
  const updated = [...libs.map((l) => l.last_report ?? l.created_at)].sort().pop();
  return {
    title: T('seo.place_title', { inPlace }),
    description: T('seo.place_desc', { n: libs.length, inPlace }),
    lastmod: updated,
    noindex: !libs.some((l) => l.indexed),
    html: `<h1>${T('seo.place_h1', { inPlace })}</h1>
      <p>${T('seo.place_lead', { n: libs.length, books: books.length, inPlace })}</p>
      <p class="muted small">${T('seo.updated', { date: fmtDate(updated, lng) })} · <a href="${withLang(`/c/${p.country.toLowerCase()}`, lng)}">${esc(country)}</a> ·
        <a href="/?at=${p.lat.toFixed(4)},${p.lon.toFixed(4)},14">${T('seo.open_map')}</a></p>
      <h2>${T('seo.libraries')}</h2>${libList(libs, T, lng)}
      ${books.length ? `<h2>${T('seo.books_now', { inPlace })}</h2>${bookList(books, lng)}` : ''}
      ${nearby.length ? `<h2>${T('seo.nearby')}</h2>${placeLinks(nearby, T, lng)}` : ''}
      <hr><p class="small">${T('shelves.note_html')}</p>`,
    jsonld: [
      breadcrumbs([[T('app.name'), '/'], [country, `/c/${p.country.toLowerCase()}`], [name, placePath(p)]]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: T('seo.place_h1', { inPlace }),
        itemListElement: libs.slice(0, 100).map((l, i) => ({ '@type': 'ListItem', position: i + 1, url: `${config.baseUrl}/l/${l.code}`, name: l.name || T('free_library') })),
      },
    ],
  };
}

async function libraryPage(lng, T, code) {
  const l = await one(
    `SELECT l.*, ST_Y(l.geom::geometry) AS lat, ST_X(l.geom::geometry) AS lon,
            p.id AS pid, p.slug AS pslug, p.name AS pname, p.name_he AS pname_he, p.country,
            ${LIB_INDEXED} AS indexed
       FROM locations l LEFT JOIN places p ON p.id = l.place_id
      WHERE l.code = $1 AND l.status = 'approved'`, [code.toUpperCase()]);
  if (!l) return null;
  const books = await many(PRESENT_BOOKS_SQL, [l.id]);
  const taken = await many(TAKEN_BOOKS_SQL, [l.id]);
  const nearby = await many(
    `SELECT l2.code, l2.name, 0 AS books FROM locations l2
      WHERE l2.status = 'approved' AND l2.id <> $1 AND ST_DWithin(l2.geom, $2::geography, 5000)
      ORDER BY EXISTS (SELECT 1 FROM sightings s WHERE s.location_id = l2.id AND s.status = 'approved') DESC,
               l2.geom::geometry <-> $2::geometry LIMIT 8`, [l.id, l.geom]);
  const place = l.pid ? { id: l.pid, slug: l.pslug, name: l.pname, name_he: l.pname_he } : null;
  const pName = place ? placeName(place, lng) : null;
  const inPlace = pName ? T('seo.in', pName) : '';
  const country = l.country ? countryName(l.country, lng) : '';
  // Unnamed (most OpenStreetMap shelves): "Street library in <town>", plus the code so titles differ.
  const name = l.name || (inPlace ? T('seo.unnamed', { inPlace }) : T('free_library'));
  const updated = books[0]?.last_seen ?? l.last_checked_at ?? l.created_at;
  return {
    title: l.name ? T('seo.lib_title', { name, inPlace }) : `${name} · ${l.code} | ${T('app.name')}`,
    description: T('seo.lib_desc', { inPlace, books: books.length }),
    lastmod: updated,
    noindex: !l.indexed,
    html: `<h1>${esc(name)}</h1>
      <p>${T('seo.lib_lead', { inPlace, country: esc(country) })}</p>
      ${l.description ? `<p>${esc(l.description)}</p>` : ''}
      <p class="muted small">${T('seo.updated', { date: fmtDate(updated, lng) })}${place ? ` · <a href="${withLang(placePath(place), lng)}">${esc(T('seo.place_h1', { inPlace }))}</a>` : ''}
        · <a href="https://www.google.com/maps/dir/?api=1&amp;destination=${l.lat},${l.lon}">${T('loc.directions')}</a></p>
      <h2>${T('loc.shelf')} (${books.length})</h2>
      ${books.length ? bookList(books, lng) : `<p>${T('loc.no_books')}</p>`}
      ${taken.length ? `<h2>${T('loc.taken_title')} (${taken.length})</h2>${bookList(taken, lng)}` : ''}
      ${nearby.length ? `<h2>${T('seo.nearby_libs')}</h2>${libList(nearby, T, lng)}` : ''}
      <hr><p class="small">${T('shelves.note_html')}</p>`,
    jsonld: [
      ...(place ? [breadcrumbs([[T('app.name'), '/'], [country, `/c/${l.country.toLowerCase()}`], [pName, placePath(place)], [name, `/l/${l.code}`]])] : []),
      {
        '@context': 'https://schema.org',
        '@type': 'Place',
        name,
        description: T('seo.lib_lead', { inPlace, country }),
        url: `${config.baseUrl}/l/${l.code}`,
        geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lon },
        ...(place ? { containedInPlace: { '@type': 'City', name: pName, url: config.baseUrl + placePath(place) } } : {}),
        isAccessibleForFree: true,
        publicAccess: true,
      },
    ],
  };
}

// Cover photos that may be shown publicly: those reported at a library, and those taken
// at home only when they were cut out to the cover itself (nothing of the home shows).
export const BOOK_PHOTOS_SQL = `
  SELECT p.id, p.kind, p.path, p.thumb_path, p.ocr_text, p.ocr_status, p.created_at FROM photos p
   WHERE p.id IN (
     SELECT unnest(ARRAY[s.photo_id, s.back_photo_id]) FROM sightings s JOIN locations l ON l.id = s.location_id
      WHERE s.book_id = $1 AND s.status = 'approved' AND l.status = 'approved'
     UNION
     SELECT unnest(ARRAY[m.photo_id, m.back_photo_id]) FROM my_books m WHERE m.book_id = $1)
     AND p.kind IN ('cover', 'back')
     AND (COALESCE(p.orig_path, p.path) ~ '_c[a-z0-9]+\\.webp$' OR EXISTS (SELECT 1 FROM sightings s WHERE s.book_id = $1 AND s.status = 'approved' AND p.id IN (s.photo_id, s.back_photo_id)))
   ORDER BY p.created_at DESC`;

// The text read from the book's public cover photos (newest of each side), once it may be
// shown: Latin-script reads at once, Hebrew ones after an admin approved them.
export async function coverTexts(bookId) {
  const photos = await many(BOOK_PHOTOS_SQL, [bookId]);
  const pick = (kind) => photos.find((p) => p.kind === kind && ['auto', 'approved'].includes(p.ocr_status) && p.ocr_text)?.ocr_text ?? null;
  return { front: pick('cover'), back: pick('back') };
}

// Where else to read about the book: by ISBN when there is one, else by title.
function bookLinks(b) {
  const q = encodeURIComponent(`${b.title} ${b.authors?.[0] ?? ''}`.trim());
  const ol = b.isbn13 ? `https://openlibrary.org/isbn/${b.isbn13}`
    : b.source_ids?.openlibrary ? `https://openlibrary.org${b.source_ids.openlibrary}` : `https://openlibrary.org/search?q=${q}`;
  const links = [
    ['Open Library', ol],
    ['Google Books', b.isbn13 ? `https://books.google.com/books?vid=ISBN${b.isbn13}` : `https://www.google.com/search?tbm=bks&q=${q}`],
    ['WorldCat', b.isbn13 ? `https://search.worldcat.org/isbn/${b.isbn13}` : `https://search.worldcat.org/search?q=${q}`],
  ];
  if (b.danacode || /[֐-׿]/.test(b.title)) links.unshift(['סימניה · Simania', `https://simania.co.il/searchBooks.php?query=${q}`]);
  return links;
}

const isbnShown = (isbn) => (isbn ? `${isbn.slice(0, 3)}-${isbn.slice(3)}` : '');
const danacodeShown = (d) => (d ? `${Number(d.slice(0, 4))}-${Number(d.slice(4, 11))}` : '');

async function bookPage(lng, T, id) {
  const b = await one('SELECT * FROM books WHERE id = $1', [id]);
  if (!b) return null;
  const libs = await many(
    `SELECT * FROM (
       SELECT DISTINCT ON (s.location_id) l.code, l.name, s.kind, s.created_at, p.name AS pname, p.name_he AS pname_he
         FROM sightings s JOIN locations l ON l.id = s.location_id LEFT JOIN places p ON p.id = l.place_id
        WHERE s.book_id = $1 AND s.status = 'approved' AND l.status = 'approved'
        ORDER BY s.location_id, s.created_at DESC) x
      ORDER BY created_at DESC LIMIT 50`, [id]);
  const owned = await one('SELECT 1 FROM my_books WHERE book_id = $1 LIMIT 1', [id]);
  const reviewed = await one('SELECT 1 FROM book_reviews WHERE book_id = $1 AND NOT hidden LIMIT 1', [id]);
  if (!libs.length && !owned && !reviewed) return null; // only books readers reported or read have pages
  const photos = await many(BOOK_PHOTOS_SQL, [id]);
  const reviews = await many(BOOK_REVIEWS_SQL, [id]);
  const offers = await many(`${OFFERS_SQL} AND m.book_id = $1 ORDER BY m.offer, m.price NULLS FIRST LIMIT 30`, [id]);
  const rated = reviews.filter((r) => r.rating);
  const avg = rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : null;
  const written = reviews.filter((r) => hasText(r.answers));
  const front = photos.find((p) => p.kind === 'cover');
  const back = photos.find((p) => p.kind === 'back');
  const frontUrl = front ? `/uploads/${front.path}` : b.front_url || b.cover_url;
  const backUrl = back ? `/uploads/${back.path}` : b.back_url;
  const shown = (p) => p && ['auto', 'approved'].includes(p.ocr_status) && p.ocr_text;
  const texts = [['seo.book_front_text', photos.find((p) => p.kind === 'cover' && shown(p))],
    ['seo.book_back_text', photos.find((p) => p.kind === 'back' && shown(p))]].filter(([, p]) => p);
  const here = libs.filter((l) => ['seen', 'added'].includes(l.kind));
  const authors = (b.authors ?? []).join(', ');
  const name = authors ? `${b.title} — ${authors}` : b.title;
  const blurb = b.description || texts.find(([k]) => k === 'seo.book_back_text')?.[1].ocr_text || '';
  const description = (blurb ? blurb.replace(/\s+/g, ' ').slice(0, 155) : T('seo.book_desc', { title: b.title, n: here.length }));
  const abs = (u) => (u?.startsWith('/') ? config.baseUrl + u : u);
  return {
    title: `${name} | ${T('app.name')}`,
    description,
    canonical: bookPath(b),
    lastmod: libs[0]?.created_at ?? b.details_at ?? b.created_at,
    html: `<article class="book-public">
      <h1 dir="auto">${esc(b.title)}</h1>
      ${authors ? `<p class="lead" dir="auto">${esc(authors)}</p>` : ''}
      <div id="fix-box"></div>
      ${frontUrl || backUrl ? `<div class="book-covers">${[[frontUrl, T('seo.book_front')], [backUrl, T('seo.book_back')]].filter(([u]) => u)
        .map(([u, cap]) => `<figure><a href="${esc(u)}"><img src="${esc(u)}" alt="${esc(`${cap}: ${b.title}`)}" loading="lazy"></a><figcaption>${cap}</figcaption></figure>`).join('')}</div>` : ''}
      <dl class="book-facts">
        ${b.isbn13 ? `<dt>ISBN</dt><dd dir="ltr">${isbnShown(b.isbn13)}</dd>` : ''}
        ${b.danacode ? `<dt>${T('seo.danacode')}</dt><dd dir="ltr">${danacodeShown(b.danacode)}</dd>` : ''}
        ${b.publisher ? `<dt>${T('seo.publisher')}</dt><dd dir="auto">${esc(b.publisher)}</dd>` : ''}
        ${b.year ? `<dt>${T('seo.year')}</dt><dd>${b.year}</dd>` : ''}
        ${b.language ? `<dt>${T('fix.f.language')}</dt><dd><a href="${`/search?all=1&language=${b.language}${lng === 'he' ? '' : '&lang=en'}`}">${T(`language.${b.language}`)}</a></dd>` : ''}
        ${b.genre ? `<dt>${T('fix.f.genre')}</dt><dd><a href="${`/search?all=1&genre=${b.genre}${lng === 'he' ? '' : '&lang=en'}`}">${T(`genre.${b.genre}`)}</a></dd>` : ''}
      </dl>
      <h2>${T('review.title')}</h2>
      ${reviews.length ? `<p class="review-sum">${T('review.n_read', { n: reviews.length })}${avg ? ` · ${stars(Math.round(avg))} ${avg.toFixed(1)} (${T('review.n_rated', { n: rated.length })})` : ''}</p>
        ${written.map((r) => reviewHtml(r, T, lng)).join('')}
        ${reviews.length > written.length ? `<p class="small">${T('review.also_read')} ${reviews.filter((r) => !hasText(r.answers))
          .map((r) => `<a href="${withLang(readerPath({ id: r.user_id, screen_name: r.screen_name }), lng)}">${esc(r.screen_name)}</a>${r.rating ? ` ${stars(r.rating)}` : ''}`).join(' · ')}</p>` : ''}`
        : `<p class="muted">${T('review.none_yet')}</p>`}
      <div id="review-box"></div>
      ${b.description ? `<h2>${T('seo.book_about')}</h2><p class="blurb" dir="auto">${esc(b.description)}</p>` : ''}
      ${texts.map(([k, p]) => `<h2>${T(k)}</h2><div class="cover-text" dir="auto">${esc(p.ocr_text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>')}</p></div>`).join('')}
      <h2>${T('seo.book_where')}</h2>
      ${here.length ? `<ul>${here.map((l) => `<li><a href="${withLang(`/l/${l.code}`, lng)}">${esc(l.name || T('free_library'))}</a>${
        l.pname ? ` · ${esc((lng === 'he' && l.pname_he) || l.pname)}` : ''} · ${T('seo.seen_on', { date: fmtDate(l.created_at, lng) })}</li>`).join('')}</ul>`
        : `<p>${T('seo.book_nowhere')}</p>`}
      ${offers.length ? `<h2>${T('offer.on_page')}</h2><ul class="offers">${offers.map((o) => `<li>
        <b>${o.offer === 'give' ? `🎁 ${T('offer.give')}` : `🏷️ ${T('offer.sale')} · ₪${o.price}`}</b>${o.condition ? ` · ${T(`offer.cond_${o.condition}`)}` : ''}${
        o.place ? ` · ${esc((lng === 'he' && o.place_he) || o.place)}` : ''} · <a href="${withLang(readerPath({ id: o.user_id, screen_name: o.screen_name }), lng)}">${esc(o.screen_name)}</a> · ${fmtDate(o.offered_at, lng)}
        ${o.offer_note ? `<br><span class="small" dir="auto">${esc(o.offer_note)}</span>` : ''}
        <br><button class="btn small" data-offer-contact="${o.id}" data-give="${o.offer === 'give' ? 1 : 0}">✉️ ${T(o.offer === 'give' ? 'offer.contact_give' : 'offer.contact_sale')}</button></li>`).join('')}</ul>` : ''}
      <h2>${T('seo.book_more')}</h2>
      <ul class="ext-links">${bookLinks(b).map(([n, u]) => `<li><a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(n)}</a></li>`).join('')}</ul>
      <hr><p class="small">${T('shelves.note_html')}</p></article>`,
    jsonld: [{
      '@context': 'https://schema.org',
      '@type': 'Book',
      name: b.title,
      ...(authors ? { author: (b.authors ?? []).map((a) => ({ '@type': 'Person', name: a })) } : {}),
      ...(b.isbn13 ? { isbn: b.isbn13 } : {}),
      ...(b.publisher ? { publisher: { '@type': 'Organization', name: b.publisher } } : {}),
      ...(b.year ? { datePublished: String(b.year) } : {}),
      ...(b.language ? { inLanguage: b.language } : {}),
      ...(frontUrl ? { image: abs(frontUrl) } : {}),
      ...(blurb ? { description: blurb.slice(0, 1000) } : {}),
      url: config.baseUrl + bookPath(b),
      ...(b.isbn13 ? { sameAs: [`https://openlibrary.org/isbn/${b.isbn13}`] } : {}),
      ...(offers.length ? { offers: offers.map((o) => ({ '@type': 'Offer', price: o.offer === 'give' ? 0 : o.price, priceCurrency: 'ILS',
        itemCondition: `https://schema.org/${o.condition === 'new' ? 'NewCondition' : 'UsedCondition'}`, availability: 'https://schema.org/InStock',
        ...(o.place ? { availableAtOrFrom: { '@type': 'Place', name: o.place } } : {}) })) } : {}),
      ...(avg ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: avg.toFixed(1), ratingCount: rated.length, bestRating: 5, worstRating: 1 } } : {}),
      ...(written.length ? { review: written.slice(0, 20).map((r) => ({
        '@type': 'Review',
        author: { '@type': 'Person', name: r.screen_name, url: config.baseUrl + readerPath({ id: r.user_id, screen_name: r.screen_name }) },
        datePublished: new Date(r.created_at).toISOString().slice(0, 10),
        reviewBody: reviewBody(r.answers),
        ...(r.rating ? { reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 } } : {}),
      })) } : {}),
    }],
  };
}

async function readerPage(lng, T, id) {
  const u = await one(
    `SELECT id, screen_name, created_at, (SELECT COALESCE(sum(points), 0)::int FROM karma_events WHERE user_id = users.id) AS karma
       FROM users WHERE id = $1 AND screen_name IS NOT NULL`, [id]);
  if (!u) return null;
  const { level } = levelOf(u.karma);
  const rows = await many(READER_REVIEWS_SQL, [id]);
  const recommended = rows.filter((r) => r.rating >= 4);
  const others = rows.filter((r) => !(r.rating >= 4));
  const item = (r) => `<li><a href="${withLang(bookPath({ id: r.book_id, title: r.title }), lng)}" dir="auto"><strong>${esc(r.title)}</strong></a>${
    r.authors?.length ? ` <span dir="auto">— ${esc(r.authors.join(', '))}</span>` : ''} ${stars(r.rating)}
    ${hasText(r.answers) ? `${reviewHtml({ ...r, screen_name: u.screen_name, user_id: u.id }, T, lng, { who: false })}` : ''}</li>`;
  const name = u.screen_name;
  return {
    title: `${T('reader.title', { name })} | ${T('app.name')}`,
    description: T('reader.desc', { name, n: rows.length, rec: recommended.length }),
    canonical: readerPath(u),
    noindex: !rows.length, // nothing to read there yet
    lastmod: rows[0]?.updated_at,
    html: `<h1 dir="auto">${esc(T('reader.title', { name }))}</h1>
      <p class="level-line">${level.badge} ${T(`level.${level.key}`)}</p>
      <p>${rows.length ? T('reader.lead', { n: rows.length, rec: recommended.length }) : T('reader.none')}</p>
      ${recommended.length ? `<h2>${T('reader.recommends')}</h2><ul class="reader-books">${recommended.map(item).join('')}</ul>` : ''}
      ${others.length ? `<h2>${T('reader.also_read')}</h2><ul class="reader-books">${others.map(item).join('')}</ul>` : ''}
      <hr><p class="small">${T('shelves.note_html')}</p>`,
    jsonld: [{
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      mainEntity: { '@type': 'Person', name, url: config.baseUrl + readerPath(u) },
    }],
  };
}

function aboutPage(lng, T) {
  return {
    title: `${T('about.title')} | ${T('app.name')}`,
    description: T('seo.home_desc'),
    html: `<h1>${T('about.title')}</h1><p>${T('about.lead_html')}</p>
      <h2>${T('shelves.title')}</h2><p>${T('shelves.note_html')}</p>
      <h2>${T('how.title')}</h2><p>${T('how.body_html')}</p>
      <h2>${T('who.title')}</h2><p>${T('who.body')}</p>
      <p>${T('contact.body')} <a href="mailto:ami@seferehov.com">ami@seferehov.com</a></p>
      <p><a href="${withLang('/places', lng)}">${T('seo.places_h1')}</a></p>
      <p class="small">${T('who.footnote')}</p>`,
    jsonld: [breadcrumbs([[T('app.name'), '/'], [T('about.title'), '/about']])],
  };
}

async function renderPath(path, lng) {
  const T = (key, vars) => translate(lng, key, vars);
  let m;
  if (path === '/') return homePage(lng, T);
  if (path === '/about') return aboutPage(lng, T);
  if (path === '/places') return placesPage(lng, T);
  if ((m = path.match(/^\/c\/([a-z]{2})$/i))) return countryPage(lng, T, m[1]);
  if ((m = path.match(/^\/p\/(\d+)(?:-[a-z0-9-]*)?$/))) return placePage(lng, T, Number(m[1]));
  if ((m = path.match(/^\/l\/([A-Za-z0-9]{4,10})$/))) return libraryPage(lng, T, m[1]);
  if ((m = path.match(/^\/b\/(\d+)(?:-[^/]*)?$/))) return bookPage(lng, T, Number(m[1]));
  if ((m = path.match(/^\/r\/(\d+)(?:-[^/]*)?$/))) return readerPage(lng, T, Number(m[1]));
  return undefined; // not a page we render: plain app shell
}

function headTags(path, lng, page) {
  path = page.canonical ?? path;
  const url = (l) => config.baseUrl + withLang(path, l);
  const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  return [
    `<link rel="canonical" href="${esc(url(lng))}">`,
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(url(l))}">`),
    `<link rel="alternate" hreflang="x-default" href="${esc(url('he'))}">`,
    `<meta property="og:url" content="${esc(url(lng))}">`,
    ...(page.noindex ? ['<meta name="robots" content="noindex">'] : []),
    ...(page.jsonld ?? []).map((o) => `<script type="application/ld+json">${json(o)}</script>`),
  ].join('\n  ');
}

function inject(html, path, lng, page) {
  const replaceMeta = (h, attr, name, value) =>
    h.replace(new RegExp(`(<meta ${attr}="${name}" content=")[^"]*(">)`), `$1${esc(value)}$2`);
  let out = html
    .replace(/<html lang="he" dir="rtl">/, `<html lang="${lng}" dir="${lng === 'he' ? 'rtl' : 'ltr'}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`);
  out = replaceMeta(out, 'name', 'description', page.description);
  out = replaceMeta(out, 'property', 'og:title', page.title);
  out = replaceMeta(out, 'property', 'og:description', page.description);
  out = out.replace('</head>', `  ${headTags(path, lng, page)}\n</head>`);
  return out.replace('<main id="view"></main>', `<main id="view"><section class="page seo">${page.html}</section></main>`);
}

// ---- sitemaps
async function sitemapIndex() {
  const { n } = await one(`SELECT count(*)::int AS n FROM locations l WHERE l.status = 'approved' AND ${LIB_INDEXED}`);
  const { n: nb } = await one(`SELECT count(*)::int AS n FROM (${SITEMAP_BOOKS_SQL}) x`);
  const parts = ['pages', ...Array.from({ length: Math.ceil(n / SITEMAP_CHUNK) }, (_, i) => `libraries-${i + 1}`),
    ...Array.from({ length: Math.ceil(nb / SITEMAP_CHUNK) }, (_, i) => `books-${i + 1}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${parts.map((p) => `  <sitemap><loc>${config.baseUrl}/sitemaps/${p}.xml</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

const urlEntry = (path, lastmod) => `  <url><loc>${config.baseUrl}${path}</loc>${
  LANGS.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${esc(config.baseUrl + withLang(path, l))}"/>`).join('')}${
  lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
const urlset = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>`;

// Last change of a library = its newest approved report, check or creation.
const LIB_LASTMOD = `GREATEST(l.created_at, l.last_checked_at,
  (SELECT max(s.created_at) FROM sightings s WHERE s.location_id = l.id AND s.status = 'approved'))`;

async function sitemapPages() {
  const places = await many(
    `SELECT p.id, p.slug, max(${LIB_LASTMOD}) AS lastmod
       FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' AND ${LIB_INDEXED} GROUP BY p.id ORDER BY p.id`);
  const countries = await many(
    `SELECT DISTINCT p.country AS cc FROM locations l JOIN places p ON p.id = l.place_id
      WHERE l.status = 'approved' AND ${LIB_INDEXED} ORDER BY 1`);
  const readers = await many(
    `SELECT u.id, u.screen_name, max(r.updated_at) AS lastmod FROM users u JOIN book_reviews r ON r.user_id = u.id AND NOT r.hidden
      WHERE u.screen_name IS NOT NULL GROUP BY u.id ORDER BY u.id`);
  return urlset([
    urlEntry('/'), urlEntry('/about'), urlEntry('/places'),
    ...readers.map((u) => urlEntry(readerPath(u), u.lastmod)),
    ...countries.map((c) => urlEntry(`/c/${c.cc.toLowerCase()}`)),
    ...places.map((p) => urlEntry(placePath(p), p.lastmod)),
  ]);
}

// Books with something to show: a library holding it, its covers, or a blurb.
export const SITEMAP_BOOKS_SQL = `
  SELECT b.id, b.title, GREATEST(b.created_at, b.details_at,
         (SELECT max(s.created_at) FROM sightings s WHERE s.book_id = b.id AND s.status = 'approved')) AS lastmod
    FROM books b
   WHERE EXISTS (SELECT 1 FROM sightings s JOIN locations l ON l.id = s.location_id
                  WHERE s.book_id = b.id AND s.status = 'approved' AND l.status = 'approved')
      OR EXISTS (SELECT 1 FROM book_reviews r WHERE r.book_id = b.id AND NOT r.hidden)
      OR (EXISTS (SELECT 1 FROM my_books m WHERE m.book_id = b.id)
          AND (b.front_url IS NOT NULL OR b.cover_url IS NOT NULL OR b.description IS NOT NULL))`;

async function sitemapBooks(part) {
  const rows = await many(`${SITEMAP_BOOKS_SQL} ORDER BY b.id LIMIT $1 OFFSET $2`, [SITEMAP_CHUNK, (part - 1) * SITEMAP_CHUNK]);
  return rows.length ? urlset(rows.map((r) => urlEntry(bookPath(r), r.lastmod))) : null;
}

async function sitemapLibraries(part) {
  const rows = await many(
    `SELECT l.code, ${LIB_LASTMOD} AS lastmod FROM locations l
      WHERE l.status = 'approved' AND ${LIB_INDEXED} ORDER BY l.id LIMIT $1 OFFSET $2`, [SITEMAP_CHUNK, (part - 1) * SITEMAP_CHUNK]);
  return rows.length ? urlset(rows.map((r) => urlEntry(`/l/${r.code}`, r.lastmod))) : null;
}

export async function renderShell(req) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const lng = url.searchParams.get('lang') === 'en' ? 'en' : 'he';
  const page = await cached(`${lng}${path}`, () => renderPath(path, lng));
  if (page === null) return { status: 404, html: indexHtml() };
  return { status: 200, html: page ? inject(indexHtml(), path, lng, page) : indexHtml() };
}

export default async function seoRoutes(app) {
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain').send(
    `User-agent: *\nDisallow: /api/\nDisallow: /me\nDisallow: /login\nDisallow: /review\nDisallow: /admin\nDisallow: /queue\nDisallow: /books\nDisallow: /scan/\nAllow: /api/locations/*/sign\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`));

  app.get('/sitemap.xml', async (req, reply) =>
    reply.type('application/xml').header('Cache-Control', 'public, max-age=3600').send(await cached('sm', sitemapIndex)));
  app.get('/sitemaps/:name', async (req, reply) => {
    const m = req.params.name.match(/^(pages|(libraries|books)-(\d+))\.xml$/);
    const xml = m && await cached(`sm:${m[1]}`, () => (m[2] === 'books' ? sitemapBooks(Number(m[3])) : m[2] ? sitemapLibraries(Number(m[3])) : sitemapPages()));
    if (!xml) return reply.code(404).send('Not found');
    return reply.type('application/xml').header('Cache-Control', 'public, max-age=3600').send(xml);
  });

  // The app's HTML fragment for a place/country page, so the app shows what search engines see.
  app.get('/api/pages', async (req, reply) => {
    const path = String(req.query.path ?? '');
    const lng = req.query.lang === 'en' ? 'en' : 'he';
    if (!/^\/(places|c\/[a-z]{2}|p\/\d+(-[a-z0-9-]*)?|[br]\/\d+(-[^/]*)?)$/i.test(path)) return reply.code(404).send({ error: 'not_found' });
    const page = await cached(`${lng}${path}`, () => renderPath(path, lng));
    if (!page) return reply.code(404).send({ error: 'not_found' });
    return { title: page.title, html: page.html };
  });
}
