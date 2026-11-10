-- The spine cut-out's shape (scans.js cropShape: blank share, long side / short side).
-- A badly cut one (short and wide, or mostly blank) is not shown on public pages.
ALTER TABLE scan_items ADD COLUMN IF NOT EXISTS crop_shape jsonb;
