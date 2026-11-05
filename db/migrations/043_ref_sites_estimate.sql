-- Books a site probably lists (shop product count or sitemap book pages), before reading it.
ALTER TABLE ref_sites ADD COLUMN est_books int, ADD COLUMN est_how text;
