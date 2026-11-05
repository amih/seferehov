-- The site page a title was read from (a listing page can give many titles; ref is the book's own page).
ALTER TABLE ref_titles ADD COLUMN page text;
