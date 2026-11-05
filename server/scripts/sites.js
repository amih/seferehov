// Reads book lists (title, author, ISBN) from publishers' own websites into the local index
// (ref_titles, source 'site'), politely and only where allowed. See docs/AUTHOR_SITES_PLAN.md.
//   node --env-file=../.env scripts/sites.js discover        Israeli publishers with a website, from Wikidata
//   node --env-file=../.env scripts/sites.js check [n]       robots.txt, terms of use and platform of new sites
//   node --env-file=../.env scripts/sites.js crawl [n]       read books from ready sites (daily page cap)
//   node --env-file=../.env scripts/sites.js site <domain>   check and read one site now
//   node --env-file=../.env scripts/sites.js report
//   node --env-file=../.env scripts/sites.js optout <domain> a site owner asked not to be read
//
// Rules:
//   - robots.txt is obeyed for the bot's own name and for *, with its Crawl-delay.
//   - A site whose terms forbid robots/scraping is 'refused'; one whose terms forbid copying
//     its content is 'ask' (listed for a person to ask by email). Neither is ever read.
//   - One request at a time, at least GAP seconds apart on the same site, at most
//     DAY_CAP pages a day in all; a 403 or 429 pauses the site.
//   - Only facts are kept: title, author, ISBN, and the page URL. No descriptions or images.
import { one, many, q, tx } from '../src/db.js';

export const UA = 'SeferehovBot/0.1 (+https://seferehov.com/bot)';
const GAP = 12_000;           // ms between requests to one site (more if Crawl-delay says so)
const DAY_CAP = 2000;         // pages a day, all sites
const PAGES_PER_VISIT = 50;   // book pages read from one site per run (method 'pages')
const STORE_PAGES = 30;       // listing requests per site per run (100–250 books each)
const RECRAWL_DAYS = 90;
const MAX_BYTES = 5 * 1024 * 1024;

const [mode, arg] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, '');

// --- fetching ------------------------------------------------------------------------------
class Paused extends Error {}
const lastHit = new Map(); // domain → ms
let fetchedToday = null;

async function countFetch() {
  const r = await one(`INSERT INTO ref_site_fetches(day, n) VALUES (current_date, 1)
    ON CONFLICT (day) DO UPDATE SET n = ref_site_fetches.n + 1 RETURNING n`);
  fetchedToday = r.n;
}
async function capReached() {
  if (fetchedToday == null) fetchedToday = (await one('SELECT n FROM ref_site_fetches WHERE day = current_date'))?.n ?? 0;
  return fetchedToday >= DAY_CAP;
}

// GET with the bot's name, waiting out the site's gap. Returns { status, url, type, text }.
async function get(url, site, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' } = {}) {
  const key = site?.domain ?? hostOf(url);
  const gap = Math.max(GAP, (site?.crawl_delay ?? 0) * 1000);
  const wait = (lastHit.get(key) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(key, Date.now());
  await countFetch();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'he,en;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { status: 0, url, type: '', text: '', error: e.cause?.code ?? e.name };
  }
  if (res.status === 403 || res.status === 429) throw new Paused(`${res.status} on ${url}`);
  const reader = res.body?.getReader();
  const chunks = []; let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length; chunks.push(value);
    if (size > MAX_BYTES) { await reader.cancel(); break; }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  return { status: res.status, url: res.url, type: res.headers.get('content-type') ?? '', text, headers: res.headers };
}

// --- robots.txt ------------------------------------------------------------------------------
// The group for our bot if there is one, else the * group. Longest matching rule wins; Allow wins ties.
export function parseRobots(txt) {
  const groups = []; let cur = null; let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (k === 'sitemap') { sitemaps.push(v); continue; }
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'allow' || k === 'disallow') cur.rules.push({ allow: k === 'allow', path: v });
    if (k === 'crawl-delay' && +v > 0) cur.delay = Math.ceil(+v);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && 'seferehovbot'.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = pick.flatMap((g) => g.rules).filter((r) => r.path || r.allow === false && r.path === '');
  const delay = Math.max(0, ...pick.map((g) => g.delay ?? 0)) || null;
  const toRe = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
  const allows = (path) => {
    let best = null;
    for (const r of rules) {
      if (!r.path) continue; // "Disallow:" (empty) allows everything
      if (!toRe(r.path).test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
    return !best || best.allow;
  };
  return { allows, delay, sitemaps };
}

async function robotsOf(site) {
  const r = await get(`https://${site.host}/robots.txt`, site, { accept: 'text/plain,*/*' });
  if (r.status >= 200 && r.status < 300 && !/<html/i.test(r.text.slice(0, 500))) return { found: true, ...parseRobots(r.text) };
  if (r.status === 401) return { found: true, allows: () => false, delay: null, sitemaps: [] };
  return { found: false, allows: () => true, delay: null, sitemaps: [] };
}

// --- page text ---------------------------------------------------------------------------------
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
export const textOf = (html) => decode(html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ url: new URL(decode(m[1]), base).href, text: textOf(m[2]).replace(/\n/g, ' ') }); } catch { /* bad href */ }
  }
  return out;
}

// --- terms of use ------------------------------------------------------------------------------
const TERMS_LINK = /תקנון|תנאי(?:\s+ה)?שימוש|terms|takanon|תנאים\s+כלליים/i;
const BAN = /אין\s|אסור|חל\s+איסור|לא\s+(?:י|ת)?(?:הא|ה)?(?:יה\s+)?(?:רשאי|מותר|ניתן)|ללא\s+(?:קבלת\s+)?(?:אישור|הסכמ|רשות)|מבלי\s+(?:לקבל\s+)?(?:אישור|הסכמ|רשות)|prohibit|forbid|may\s+not|must\s+not|not\s+(?:permitted|allowed)|without\s+(?:the\s+)?(?:prior\s+)?(?:written\s+)?(?:consent|permission)/i;
const BOTS = /רובוט|זחלן|זחלנ|סורק|סריק(?:ה|ת)\s+(?:אוטומטית|ממוחשבת)|כריית|כריה|crawl|scrap|spider|robot|\bbots?\b|data\s*mining|אמצעי(?:ם)?\s+אוטומטי|באופן\s+אוטומטי|תוכנ(?:ה|ות)\s+(?:אוטומטי|לאיסוף)|איסוף\s+(?:מידע|נתונים)\s+(?:אוטומטי|ממוחשב)/i;
const COPY = /להעתיק|העתקה|העתקת|לשכפל|שכפול|copy|reproduc|להפיץ|הפצה/i;

// Splits the terms into sentences and looks for a ban on robots, then on copying.
export function judgeTerms(text) {
  const sentences = text.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 10);
  const bots = sentences.find((s) => BOTS.test(s) && BAN.test(s));
  if (bots) return { terms: 'bots_ban', note: bots.slice(0, 500) };
  const copy = sentences.find((s) => COPY.test(s) && BAN.test(s));
  if (copy) return { terms: 'copy_ban', note: copy.slice(0, 500) };
  return { terms: 'ok', note: null };
}

function platformOf(html, headers) {
  if (/woocommerce/i.test(html)) return 'woocommerce';
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(html) || headers?.get?.('x-shopid')) return 'shopify';
  if (/static\.wixstatic\.com|wix-thunderbolt|parastorage\.com/i.test(html)) return 'wix';
  if (/wp-content|wp-includes/i.test(html)) return 'wordpress';
  return 'other';
}

// --- discovery -----------------------------------------------------------------------------------
const NOISE = /facebook|twitter|instagram|linkedin|youtube|wikipedia|\.ac\.il$|\.edu$|gov\.il$|knesset|tiktok|google\.com|linktr\.ee/i;

async function sparql(query) {
  const PREFIX = `PREFIX wd: <http://www.wikidata.org/entity/> PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>`;
  let res;
  // A shared public endpoint: on "too many requests" wait 1, 2, 4, 8 minutes.
  for (const wait of [0, 60, 120, 240, 480]) {
    if (wait) { log(`qlever busy, waiting ${wait} s`); await sleep(wait * 1000); }
    res = await fetch('https://qlever.dev/api/wikidata', { method: 'POST', body: new URLSearchParams({ query: `${PREFIX} ${query}` }),
      headers: { Accept: 'text/tab-separated-values', 'User-Agent': UA }, signal: AbortSignal.timeout(300_000) });
    if (res.status !== 429 && res.status < 500) break;
  }
  if (!res.ok) throw new Error(`qlever ${res.status}`);
  const [head, ...lines] = (await res.text()).split('\n').filter(Boolean);
  const cols = head.split('\t').map((c) => c.replace(/^\?/, ''));
  const val = (v) => (v ?? '').replace(/^"(.*)"(@[\w-]+|\^\^.*)?$/s, '$1').replace(/^<http:\/\/www\.wikidata\.org\/entity\/(Q\d+)>$/, '$1').replace(/^<(.*)>$/, '$1');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], val(v)])));
}

async function discover() {
  // Publishing houses (and subclasses) in Israel with an official website.
  const rows = await sparql(`SELECT DISTINCT ?p ?name ?site WHERE {
    ?p wdt:P31/wdt:P279* wd:Q2085381 . ?p wdt:P17 wd:Q801 . ?p wdt:P856 ?site .
    OPTIONAL { ?p rdfs:label ?name FILTER(LANG(?name) = "he") } }`);
  let added = 0;
  for (const r of rows) {
    let domain;
    try { domain = hostOf(r.site); } catch { continue; }
    if (NOISE.test(domain)) continue;
    const res = await q(`INSERT INTO ref_sites(domain, url, kind, name, found_by, wikidata) VALUES ($1, $2, 'publisher', $3, 'wikidata', $4)
      ON CONFLICT (domain) DO NOTHING`, [domain, r.site, r.name || null, r.p]);
    added += res.rowCount;
  }
  log(`discover: ${rows.length} publishers with a website in Wikidata, ${added} new sites`);
}

// --- check: robots, terms, platform ------------------------------------------------------------------
async function check(site) {
  site.host = new URL(site.url).host;
  const robots = await robotsOf(site);
  site.crawl_delay = robots.delay;
  const set = async (fields) => {
    const keys = Object.keys(fields);
    await q(`UPDATE ref_sites SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, checked_at = now() WHERE id = $1`, [site.id, ...keys.map((k) => fields[k])]);
  };
  if (!robots.allows('/')) return set({ robots: 'refused', crawl_delay: robots.delay, status: 'refused', note: 'robots.txt forbids the home page' });
  const home = await get(site.url, site);
  if (home.status < 200 || home.status >= 400 || home.text.length < 200) return set({ robots: robots.found ? 'allowed' : 'none', status: 'dead', note: `home page: ${home.status || home.error}` });
  // The site may have moved to another domain.
  const finalHost = new URL(home.url).host;
  const platform = platformOf(home.text, home.headers);
  const termsLink = links(home.text, home.url).filter((l) => TERMS_LINK.test(l.text) || TERMS_LINK.test(decodeURIComponent(l.url)))
    .filter((l) => hostOf(l.url) === hostOf(home.url)).sort((a, b) => /תקנון|שימוש|terms/i.test(b.text) - /תקנון|שימוש|terms/i.test(a.text))[0];
  let terms = { terms: 'none', note: null };
  if (termsLink) {
    if (!robots.allows(new URL(termsLink.url).pathname)) terms = { terms: 'none', note: 'terms page closed to robots' };
    else {
      const page = await get(termsLink.url, site);
      if (page.status === 200) terms = judgeTerms(textOf(page.text));
    }
  }
  const status = terms.terms === 'bots_ban' ? 'refused' : terms.terms === 'copy_ban' ? 'ask' : 'ready';
  await set({ robots: robots.found ? 'allowed' : 'none', crawl_delay: robots.delay, platform, terms_url: termsLink?.url ?? null,
    terms: terms.terms, terms_note: terms.note, status, note: finalHost !== site.host ? `moved to ${finalHost}` : null });
  log(`${site.domain}: ${platform}, terms ${terms.terms} → ${status}`);
}

// --- reading books ------------------------------------------------------------------------------------
const NOT_BOOK = /^(?:ספרי|כל ספרי|סדרת|טרילוגיית)\s|במבצע|מארז|ערכת|ערכה|שובר|גיפט\s*קארד|כרטיס\s+מתנה|gift\s*card|מנוי|דמי\s+משלוח|תיק\s+בד|משחק|פאזל|לוח\s+שנה|גלויות|מחברת|סימניה|bundle|box\s+set|t-shirt|חולצ/i;
const ISBN_RE = /\b97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?\d\b/;
const isbnOf = (...vals) => {
  for (const v of vals) {
    const m = String(v ?? '').match(ISBN_RE);
    if (m) { const d = m[0].replace(/\D/g, ''); if (d.length === 13) return d; }
  }
  return null;
};
// "שם הספר - כריכה רכה", "שם הספר (ספר דיגיטלי)" → "שם הספר"
export function cleanTitle(name) {
  let t = decode(String(name ?? '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[-–|(]\s*(?:כריכה\s+(?:רכה|קשה)|ספר\s+(?:דיגיטלי|אלקטרוני|מודפס|קולי)|e-?book|הדפסה\s+\S+|מהדורה\s+\S+|חדש!?|מבצע)\)?\s*$/i, '').trim();
  t = t.replace(/^ספר\s*[-–:]\s*/, '').replace(/^["“”']+|["“”']+$/g, '').trim();
  return t;
}
const AUTHOR_ATTR = /מחבר|מחברת|סופר|סופרת|מאת|כותב|author|writer/i;
const authorFromText = (s) => {
  const m = String(s ?? '').replace(/<[^>]+>/g, ' ').match(/(?:^|[\s,.:])מאת[:\s]+([^\n,.<(|]{3,40})/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
};
const book = (title, author, isbn, ref, year = null) => {
  const t = cleanTitle(title);
  if (!t || t.length < 2 || t.length > 150 || NOT_BOOK.test(t)) return null;
  return { title: t, author: author ? cleanTitle(author).slice(0, 80) : null, isbn, ref, year };
};

// WooCommerce Store API: 100 products a request, public and read-only.
async function wooStore(site, robots) {
  for (const path of ['/wp-json/wc/store/v1/products', '/wp-json/wc/store/products']) {
    if (!robots.allows(path)) continue;
    const books = []; let pages = 1;
    for (let p = 1; p <= Math.min(pages, STORE_PAGES); p++) {
      const r = await get(`https://${site.host}${path}?per_page=100&page=${p}`, site, { accept: 'application/json' });
      if (r.status !== 200 || !/json/.test(r.type)) break;
      let list; try { list = JSON.parse(r.text); } catch { break; }
      if (!Array.isArray(list)) break;
      pages = +(r.headers.get('x-wp-totalpages') ?? 1);
      for (const x of list) {
        const attr = (x.attributes ?? []).find((a) => AUTHOR_ATTR.test(a.name));
        const author = attr?.terms?.map((t) => t.name).join(', ') || authorFromText(x.short_description) || authorFromText(x.description);
        const isbnAttr = (x.attributes ?? []).find((a) => /isbn|מסת"?ב|ברקוד/i.test(a.name));
        const b = book(x.name, author, isbnOf(x.sku, isbnAttr?.terms?.[0]?.name, x.short_description, x.description), x.permalink);
        if (b) books.push(b);
      }
      if (await capReached()) break;
    }
    if (books.length) return { method: 'woo-store', books, complete: pages <= STORE_PAGES };
  }
  return null;
}

// Shopify: /products.json, 250 products a request.
async function shopify(site, robots) {
  if (!robots.allows('/products.json')) return null;
  const books = [];
  for (let p = 1; p <= STORE_PAGES; p++) {
    const r = await get(`https://${site.host}/products.json?limit=250&page=${p}`, site, { accept: 'application/json' });
    if (r.status !== 200) break;
    let list; try { list = JSON.parse(r.text).products; } catch { break; }
    if (!list?.length) break;
    for (const x of list) {
      const b = book(x.title, authorFromText(x.body_html), isbnOf(...(x.variants ?? []).flatMap((v) => [v.barcode, v.sku]), x.body_html), `https://${site.host}/products/${x.handle}`);
      if (b) books.push(b);
    }
    if (list.length < 250 || await capReached()) break;
  }
  return books.length ? { method: 'shopify', books, complete: true } : null;
}

// Sitemaps: the URLs of product/book pages, stored in ref_site_pages.
const PRODUCT_URL = /\/(product|products|book|books|item|p|ספר|ספרים|store-products?|product-page)\/|[?&](product_id|wpsc-product)=/i;
async function sitemapUrls(site, robots) {
  const queue = [...new Set([...robots.sitemaps, `https://${site.host}/sitemap.xml`, `https://${site.host}/sitemap_index.xml`, `https://${site.host}/wp-sitemap.xml`])];
  const seen = new Set(); const urls = new Set();
  while (queue.length && seen.size < 20) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let path; try { path = new URL(sm).pathname; } catch { continue; }
    if (!robots.allows(path)) continue;
    const r = await get(sm, site, { accept: 'application/xml,text/xml' });
    if (r.status !== 200 || !/<(urlset|sitemapindex)/.test(r.text)) continue;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) => decode(m[1]));
    if (/<sitemapindex/.test(r.text)) {
      // Product sitemaps first; skip posts, tags, authors, images.
      const subs = locs.filter((u) => !/post|tag|author|category|image|page-sitemap|attachment|blog|news/i.test(u));
      subs.sort((a, b) => /product|book|store/i.test(b) - /product|book|store/i.test(a));
      queue.unshift(...subs);
    } else {
      const productMap = /product|book|store/i.test(sm);
      for (const u of locs) {
        let p; try { p = new URL(u); } catch { continue; }
        if (hostOf(p.href) !== hostOf(`https://${site.host}`)) continue;
        if (productMap || PRODUCT_URL.test(decodeURI(p.pathname) + p.search)) if (robots.allows(p.pathname)) urls.add(p.href);
      }
    }
    if (await capReached()) break;
  }
  return [...urls];
}

// The books on one page: schema.org Book/Product as JSON-LD or microdata (a listing page may
// hold many), else, for a page about one book (an ISBN or a single author line), its title.
export function booksFromPage(html, url) {
  const nameOf = (a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.map(nameOf).filter(Boolean).join(', ') : a?.name ?? null);
  const out = [];
  const items = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (x) => {
        if (Array.isArray(x)) return x.forEach(walk);
        if (!x || typeof x !== 'object') return;
        const types = [].concat(x['@type'] ?? []);
        if (types.some((t) => /^(Book|Product)$/.test(t))) items.push(x);
        if (x['@graph']) walk(x['@graph']);
        if (x.itemListElement) walk([].concat(x.itemListElement).map((e) => e.item ?? e));
      };
      walk(JSON.parse(m[1].trim()));
    } catch { /* bad JSON-LD */ }
  }
  for (const x of items) {
    const extra = (x.additionalProperty ?? []).find?.((p) => AUTHOR_ATTR.test(p.name ?? ''))?.value;
    const b = book(x.name, nameOf(x.author) ?? extra ?? authorFromText(x.description), isbnOf(x.isbn, x.gtin13, x.gtin, x.sku), x.url ?? url);
    if (b) out.push(b);
  }
  // Microdata: <div itemscope itemtype="http://schema.org/Book"> … itemprop="name" / "author" / "isbn".
  const parts = html.split(/<[^>]+itemtype=["']https?:\/\/schema\.org\/(?:Book|Product)["'][^>]*>/i).slice(1);
  const prop = (chunk, name) => {
    const c = chunk.match(new RegExp(`itemprop=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1];
    if (c) return decode(c);
    const m = chunk.match(new RegExp(`<(\\w+)[^>]*itemprop=["']${name}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
    return m ? textOf(m[2]).replace(/\n/g, ' ').trim() : null;
  };
  for (const chunk of parts) {
    const b = book(prop(chunk, 'name'), prop(chunk, 'author'), isbnOf(prop(chunk, 'isbn'), prop(chunk, 'gtin13')), url);
    if (b) out.push(b);
  }
  if (out.length) return out;
  // No structured data: only a page about one book.
  const text = textOf(html);
  const isbns = [...new Set([...text.matchAll(/(?:ISBN|מסת"?ב|מסת״ב)[^\d]{0,12}(97[89][\d-\s]{10,16})/gi)].map((m) => m[1]))];
  const authorLines = [...text.matchAll(/(?:^|\n)\s*(?:מחבר(?:ת)?|סופר(?:ת)?|מאת|author)\s*[:：]\s*([^\n]{3,60})/gi)].map((m) => m[1]);
  if (isbns.length > 1 || authorLines.length > 1 || (!isbns.length && !authorLines.length)) return [];
  const site = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  let title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (!title) return [];
  title = decode(title);
  // "Site name - Book title" or "Book title | Site name": drop the site's own name.
  const segs = title.split(/\s+[|–-]\s+/);
  if (segs.length > 1) {
    const isSite = (x) => (site && (x.includes(decode(site)) || decode(site).includes(x)));
    const keep = segs.filter((x) => !isSite(x));
    title = (keep.length && keep.length < segs.length ? keep : segs.slice(0, -1)).join(' - ');
  }
  const b = book(title, authorLines[0], isbnOf(isbns[0]), url);
  return b ? [b] : [];
}

async function pages(site, robots) {
  const known = (await one('SELECT count(*)::int AS n FROM ref_site_pages WHERE site_id = $1', [site.id])).n;
  if (!known || (site.next_crawl && new Date(site.next_crawl) < new Date())) {
    const urls = await sitemapUrls(site, robots);
    if (!urls.length && !known) return null;
    for (let i = 0; i < urls.length; i += 1000) {
      const b = urls.slice(i, i + 1000);
      await q(`INSERT INTO ref_site_pages(url, site_id) SELECT unnest($1::text[]), $2 ON CONFLICT (url) DO NOTHING`, [b, site.id]);
    }
  }
  const todo = await many(`SELECT url FROM ref_site_pages WHERE site_id = $1 AND (fetched_at IS NULL OR fetched_at < now() - interval '${RECRAWL_DAYS} days')
    ORDER BY fetched_at NULLS FIRST, url LIMIT ${PAGES_PER_VISIT}`, [site.id]);
  let found = 0; let tried = 0;
  for (const { url } of todo) {
    if (await capReached()) break;
    const r = await get(url, site);
    tried++;
    const bs = r.status === 200 ? booksFromPage(r.text, url) : [];
    await tx(async (db) => {
      await db.query('DELETE FROM ref_titles WHERE site_id = $1 AND page = $2', [site.id, url]);
      for (const b of bs) {
        // A book already listed on another page of the site (a listing and its own page): keep one.
        const dup = await db.query('SELECT 1 FROM ref_titles WHERE site_id = $1 AND title = $2 AND coalesce(author, \'\') = coalesce($3, \'\')', [site.id, b.title, b.author]);
        if (dup.rowCount) continue;
        await db.query(`INSERT INTO ref_titles(title, author, year, source, ref, title_f, author_f, site_id, isbn, page)
          VALUES ($1, $2, $3, 'site', $4, heb_fold($1), heb_fold($2), $5, $6, $7)`, [b.title, b.author, b.year, b.ref, site.id, b.isbn, url]);
      }
      await db.query('UPDATE ref_site_pages SET fetched_at = now(), found = $2 WHERE url = $1', [url, bs.length]);
    });
    found += bs.length;
    // Ten book-less pages in a row at the start: the sitemap is not a book list.
    if (tried >= 10 && found === 0 && !known) return { method: 'pages', books: null, gaveUp: true };
  }
  const left = (await one(`SELECT count(*)::int AS n FROM ref_site_pages WHERE site_id = $1 AND fetched_at IS NULL`, [site.id])).n;
  return { method: 'pages', found, complete: left === 0 };
}

async function crawl(site) {
  site.host = new URL(site.url).host;
  const robots = await robotsOf(site);
  if (!robots.allows('/')) return q(`UPDATE ref_sites SET status = 'refused', robots = 'refused', note = 'robots.txt now forbids the site' WHERE id = $1`, [site.id]);
  site.crawl_delay = robots.delay ?? site.crawl_delay;
  // Home page moved (www., another domain): follow it once.
  if (!site.method) {
    const home = await get(site.url, site);
    if (home.status === 200) site.host = new URL(home.url).host;
  }
  const order = { woocommerce: [wooStore, pages], shopify: [shopify, pages] }[site.platform] ?? [pages];
  const tryOrder = site.method ? order.filter((f) => ({ 'woo-store': wooStore, shopify, pages }[site.method] === f)) : order;
  for (const fn of tryOrder) {
    const got = await fn(site, robots);
    if (!got) continue;
    if (got.books) {
      // A whole-store listing replaces everything this site gave before.
      await tx(async (db) => {
        await db.query('DELETE FROM ref_titles WHERE site_id = $1', [site.id]);
        const bs = [...new Map(got.books.map((b) => [`${b.title}\t${b.author ?? ''}`, b])).values()];
        for (let i = 0; i < bs.length; i += 2000) {
          const c = bs.slice(i, i + 2000);
          await db.query(`INSERT INTO ref_titles(title, author, year, source, ref, title_f, author_f, site_id, isbn)
            SELECT t, a, NULL, 'site', r, heb_fold(t), heb_fold(a), $5, i FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(t, a, r, i)`,
            [c.map((b) => b.title), c.map((b) => b.author), c.map((b) => b.ref), c.map((b) => b.isbn), site.id]);
        }
      });
    }
    if (got.gaveUp) continue;
    const n = (await one('SELECT count(*)::int AS n FROM ref_titles WHERE site_id = $1', [site.id])).n;
    const done = got.complete;
    await q(`UPDATE ref_sites SET method = $2, books = $3, crawled_at = now(), status = $4,
      next_crawl = CASE WHEN $5 THEN now() + interval '${RECRAWL_DAYS} days' ELSE next_crawl END WHERE id = $1`,
    [site.id, got.method, n, n ? (done ? 'done' : 'ready') : (done ? 'no_books' : 'ready'), done]);
    log(`${site.domain}: ${got.method}, ${n} books${done ? '' : ' so far'}`);
    return;
  }
  await q(`UPDATE ref_sites SET status = 'no_books', crawled_at = now(), next_crawl = now() + interval '${RECRAWL_DAYS} days' WHERE id = $1`, [site.id]);
  log(`${site.domain}: no book list found`);
}

async function eachSite(sql, fn, limit) {
  const sites = await many(`${sql} LIMIT ${Math.max(1, +limit || 1000)}`);
  for (const site of sites) {
    if (await capReached()) { log(`daily cap of ${DAY_CAP} pages reached`); break; }
    try { await fn(site); } catch (e) {
      if (e instanceof Paused) {
        await q(`UPDATE ref_sites SET status = 'paused', note = $2, next_crawl = now() + interval '30 days' WHERE id = $1`, [site.id, e.message]);
        log(`${site.domain}: paused (${e.message})`);
      } else log(`${site.domain}: error ${e.message}`);
    }
  }
}

async function report() {
  const rows = await many(`SELECT status, count(*)::int AS sites, sum(books)::int AS books FROM ref_sites GROUP BY status ORDER BY sites DESC`);
  console.table(rows);
  console.table(await many(`SELECT terms, count(*)::int FROM ref_sites WHERE checked_at IS NOT NULL GROUP BY terms`));
  console.table(await many(`SELECT domain, method, books, status FROM ref_sites WHERE books > 0 ORDER BY books DESC LIMIT 40`));
  console.log('pages fetched today:', (await one('SELECT n FROM ref_site_fetches WHERE day = current_date'))?.n ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (mode === 'discover') await discover();
    else if (mode === 'check') await eachSite(`SELECT * FROM ref_sites WHERE status = 'new' ORDER BY id`, check, arg);
    else if (mode === 'crawl') {
      // Sites whose terms were never checked are checked first; then ready sites, those never read first.
      await eachSite(`SELECT * FROM ref_sites WHERE status = 'new' ORDER BY id`, check, 50);
      await eachSite(`SELECT * FROM ref_sites WHERE status = 'ready' OR (status IN ('done', 'no_books', 'paused') AND next_crawl < now())
        ORDER BY crawled_at NULLS FIRST, id`, crawl, arg);
    } else if (mode === 'site' && arg) {
      // One site now, whatever its schedule (still only if allowed).
      const d = arg.replace(/^www\./, '');
      await eachSite(`SELECT * FROM ref_sites WHERE domain = '${d.replace(/'/g, "''")}' AND status = 'new'`, check, 1);
      await eachSite(`SELECT * FROM ref_sites WHERE domain = '${d.replace(/'/g, "''")}' AND status IN ('ready', 'done', 'no_books')`, crawl, 1);
    } else if (mode === 'report') await report();
    else if (mode === 'optout' && arg) {
      const r = await q(`UPDATE ref_sites SET status = 'opted_out', note = 'owner asked' WHERE domain = $1`, [arg.replace(/^www\./, '')]);
      await q(`DELETE FROM ref_titles WHERE site_id IN (SELECT id FROM ref_sites WHERE domain = $1)`, [arg.replace(/^www\./, '')]);
      log(r.rowCount ? `${arg}: opted out, its books removed` : `${arg}: not known`);
    } else console.error('usage: sites.js discover | check [n] | crawl [n] | report | optout <domain>');
  } finally { (await import('../src/db.js')).pool.end(); }
}
