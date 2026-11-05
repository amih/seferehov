-- Local index of book titles and author names from free, reusable sources (Hebrew
-- Wikipedia, Wikidata, Project Ben-Yehuda), filled by deploy/refs-refresh.sh. A spine
-- reading no catalogue knows is matched here (server/src/refindex.js) before the web.
--
-- heb_fold: the key misreadings are matched on. Vowel points, quotes and punctuation go;
-- final letters become regular ones; letters the OCR mixes up become one letter
-- (ד/ר, כ/ב, ח/ת/ה, ז/ו); ו and י, written or left out freely in Hebrew, are dropped.
CREATE OR REPLACE FUNCTION heb_fold(s text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      translate(
        translate(regexp_replace(lower(coalesce(s, '')), '[֑-ׇ׳״''"`]', '', 'g'), 'ךםןףץ', 'כמנפצ'),
        'דכחתז', 'רבההו'),
      'וי', ''),
    '[^[:alnum:]]+', ' ', 'g'))
$$;

CREATE TABLE ref_titles (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  author text,
  year int,
  source text NOT NULL,          -- hewiki | wikidata | benyehuda
  ref text,                      -- page title / Q-id / work id
  title_f text NOT NULL,
  author_f text
);
CREATE INDEX ref_titles_f_trgm ON ref_titles USING gin (title_f gin_trgm_ops);
CREATE INDEX ref_titles_source ON ref_titles (source);

CREATE TABLE ref_authors (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL,          -- wikidata | hewiki | benyehuda
  ref text,
  name_f text NOT NULL
);
CREATE INDEX ref_authors_f_trgm ON ref_authors USING gin (name_f gin_trgm_ops);
CREATE INDEX ref_authors_source ON ref_authors (source);

-- How sure the server is of a book before the reader sees it (0–100), and why; the
-- approval queue shows the surest first.
ALTER TABLE scan_items ADD COLUMN confidence smallint, ADD COLUMN confidence_why text;
UPDATE scan_items SET confidence = CASE quality WHEN 'high' THEN 85 WHEN 'medium' THEN 40 ELSE 20 END,
  confidence_why = CASE quality WHEN 'high' THEN 'catalogue' WHEN 'medium' THEN 'read' ELSE 'low' END
 WHERE decision IS NULL OR decision = 'later';
