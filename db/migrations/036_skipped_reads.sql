-- Shelf reads not worth a reader's time (a low-quality read that no catalogue knows, or a
-- misread of a book read better in the same scan) stay out of the queue: decision
-- 'skipped'. Nothing is deleted; the reader can bring them back, and then they stay (keep_read).
ALTER TABLE scan_items DROP CONSTRAINT scan_items_decision_check;
ALTER TABLE scan_items ADD CONSTRAINT scan_items_decision_check CHECK (decision = ANY (ARRAY['approved', 'declined', 'later', 'merged', 'skipped']));
ALTER TABLE scan_items ADD COLUMN keep_read boolean NOT NULL DEFAULT false;
