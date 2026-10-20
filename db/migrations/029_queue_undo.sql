-- An approved book of the reader's own (My books) remembers its queue item, so the
-- approval can be undone like one at a library.
ALTER TABLE scan_items ADD COLUMN my_book_id bigint REFERENCES my_books(id) ON DELETE SET NULL;
CREATE INDEX scan_items_decided_idx ON scan_items(decided_at DESC) WHERE decided_at IS NOT NULL;
