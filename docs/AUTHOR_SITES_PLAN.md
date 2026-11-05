# Plan: book lists from authors' and small publishers' own websites

Status: plan only, nothing built. Written 2026-11-05.

## Why

Hebrew Wikipedia and Wikidata know about 40–55% of the Hebrew titles seen on shelves so
far, and the National Library catalogue only finds a title spelled exactly as in its
records. The missing books are the long tail: small and recent books, self-published
authors, children's books, local history. Many of their authors and small publishers
have their own website with a "my books" page. Those pages are the long tail's catalogue.

The big Hebrew book sites (Simania, Tzomet Sfarim, Steimatzky, Mendele, Indiebook) forbid
copying in their terms of use, so they are left alone. e-vrit's terms could not be read.
This plan only reads sites that allow it.

## What is collected

Facts only: title, author, ISBN, publisher and year, plus the page they were read from.
Descriptions, cover images and reviews are not copied (a cover may be linked to, not
stored). Rows go into the existing `ref_titles` index with `source = 'site'` and
`ref = <page URL>`, so the spine matching (server/src/refindex.js) uses them as-is.

## Steps

### 1. Find the sites

1. **Wikidata "official website" (P856)**: authors and publishers with a Hebrew label
   and an official website. A direct list with no searching. Count it first; this
   alone may be most of the value.
2. **Hebrew Wikipedia**: the `{{אתר רשמי}}` template and the external-link lines of
   author pages, from the dump that is already downloaded monthly.
3. **Authors seen on shelves**: names in `books.authors` and in `ref_authors` that have
   no site from 1 or 2. They are searched through the same throttled SearXNG, with a
   separate daily budget (for example 50 searches a day out of the 300), so spine
   corrections always come first. Query: `"<name>" סופר ספרים` and `"<name>" אתר`.
4. **Telling an author's site from noise**: the domain or the page title contains the
   name (Hebrew or transliterated), the page talks about books (ספרי, ספרים, הוצאה,
   ISBN, "books"), and the domain is not on a blocklist of retailers, news sites,
   Wikipedia, social networks and the big book sites.

Each found site is stored in a new table `ref_sites` (domain, kind author/publisher,
author, how it was found, robots verdict, terms verdict, last crawl, books found,
status).

### 2. Check permission, per site

- **robots.txt** for the bot's own user agent (`SeferehovBot/0.1 (+https://seferehov.com/bot)`):
  obey Disallow and Crawl-delay; no robots.txt = allowed.
- **Terms of use**: find the תקנון / terms page and scan it for bans on copying,
  robots or scraping (the check used for the big sites on 2026-11-05). A ban → the site
  is marked `refused` and never read.
- **Valuable sites that refuse** (a publisher with hundreds of titles): listed for a
  person to ask by email. Never read without a written yes.
- A page at `/bot` on seferehov.com explains what the bot reads and how to opt out
  (a robots.txt line or an email), and opting out is honoured.

### 3. Read the books

In order of reliability:
1. Structured data: schema.org `Book` / `Product` JSON-LD, microdata, OpenGraph `book:*`.
2. WooCommerce and similar shop pages (common on Israeli author sites): product title, and
   the ISBN in the product's attributes.
3. Pages called books / ספרים / ספרי / הספרים שלי: the local text model (the same Qwen
   that reads spines) lists title | author | ISBN | year from the page text. A row is
   kept only when the title appears in the page text exactly.

An ISBN found this way is also looked up in the catalogues, which gives a cross-check.

### 4. Play nice

- One request at a time per site, at least 10–30 seconds apart (more if Crawl-delay asks).
- At most 50 pages per site per visit, found through the sitemap or the site's own
  book-page links.
- At most 2,000 pages a day in all.
- Each site is read again only every 90 days, with If-Modified-Since / ETag.
- Stop at the first 403 or 429 and mark the site `paused`.

### 5. Measure, then decide

The scan evidence (`scan_item_evidence`, view `evidence_by_source`) already records
`index:<source>` corrections and what the reader then did. With `source = 'site'` it
shows directly how many shelf books the author sites corrected or confirmed, and how
often the reader had to fix them. If after 2–3 months they help on fewer than about
2% of the spines that reach the index, the crawling stops.

## Estimates

These are guesses until step 1.1 is counted.

| | Estimate |
|---|---|
| Authors and publishers with an official website in Wikidata | count first (P856) |
| Sites found by searching | ~1 in 4 authors searched; 50 searches a day ≈ 350 a week |
| Sites that allow reading | perhaps half of personal sites; few commercial ones |
| Books per site | 3–30 for an author, up to hundreds for a small publisher |
| Disk | under 50 MB for 100,000 books |
| Build time | about 3–4 days: discovery 1, permission checks 0.5, extraction 1.5, measuring 0.5 |
| Running time | weeks to months to cover the tail at the polite pace; most of the gain comes from the first few hundred sites |

## Order of work

1. Count Wikidata P856 for Hebrew-labelled authors and publishers, and read 20 of those sites by hand
   to see what format their book lists use. Decide from that whether to go on.
2. `ref_sites` table, robots and terms checks, the `/bot` page.
3. Structured-data and WooCommerce extraction; then the model-based fallback.
4. Search-based discovery for authors seen on shelves.
5. Monthly timer, measuring through `evidence_by_source`.
