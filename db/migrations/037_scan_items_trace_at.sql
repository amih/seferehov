-- Where in the scan's trace this book was read: the photo and the cut-out (or "find: <title>")
-- the kept reading came from, e.g. {"photo 2","cut-out 4"}. The approval screen shows those steps.
ALTER TABLE scan_items ADD COLUMN trace_at text[];
