-- Titles by an author (refindex.titlesBy): a cover whose author was read well and title badly.
CREATE INDEX IF NOT EXISTS ref_titles_author_trgm ON ref_titles USING gin (author_f gin_trgm_ops);
