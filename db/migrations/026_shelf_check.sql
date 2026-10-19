-- A spine read from a shelf photo that is a book already on that library's shelf is
-- confirmed without asking (auto = true): it only says the book is still there.
ALTER TABLE scan_items ADD COLUMN auto boolean NOT NULL DEFAULT false;
