-- Book lists read from publishers' (later: authors') own websites, by scripts/sites.js.
-- A site is read only when its robots.txt allows the bot and its terms of use do not
-- forbid robots or copying (docs/AUTHOR_SITES_PLAN.md). Titles go into ref_titles with
-- source = 'site' and site_id, so the spine matching uses them like any other source.
CREATE TABLE ref_sites (
  id serial PRIMARY KEY,
  domain text NOT NULL UNIQUE,     -- host without www.
  url text NOT NULL,               -- home page as listed
  kind text NOT NULL CHECK (kind IN ('publisher', 'author')),
  name text,
  found_by text NOT NULL,          -- wikidata | hewiki | search | manual
  wikidata text,
  robots text,                     -- allowed | refused | none (no robots.txt)
  crawl_delay int,                 -- seconds, from robots.txt
  terms_url text,
  terms text,                      -- none (no terms page) | ok | bots_ban | copy_ban
  terms_note text,                 -- the sentence that bans, for a person to read
  platform text,                   -- woocommerce | shopify | wix | wordpress | other
  method text,                     -- how the books were read: woo-store | shopify | pages
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'ready', 'refused', 'ask', 'paused', 'dead', 'no_books', 'done', 'opted_out')),
  books int NOT NULL DEFAULT 0,
  note text,
  checked_at timestamptz,
  crawled_at timestamptz,
  next_crawl timestamptz
);

-- One row per book page found in a site's sitemap (method 'pages'): read once, again after 90 days.
CREATE TABLE ref_site_pages (
  url text PRIMARY KEY,
  site_id int NOT NULL REFERENCES ref_sites(id) ON DELETE CASCADE,
  fetched_at timestamptz,
  found int
);
CREATE INDEX ref_site_pages_site ON ref_site_pages (site_id, fetched_at);

-- Pages fetched per day, for the daily cap.
CREATE TABLE ref_site_fetches (day date PRIMARY KEY, n int NOT NULL DEFAULT 0);

ALTER TABLE ref_titles ADD COLUMN site_id int REFERENCES ref_sites(id) ON DELETE CASCADE;
ALTER TABLE ref_titles ADD COLUMN isbn text;
CREATE INDEX ref_titles_site ON ref_titles (site_id) WHERE site_id IS NOT NULL;
