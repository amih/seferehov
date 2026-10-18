-- The text printed on a cover photo, read in the background (for the public book page).
-- ocr_status: 'auto' = clean read, shown; 'review' = waits for an admin (Hebrew reads
-- are rough); 'approved' = an admin checked or fixed it; 'rejected' = never shown.
ALTER TABLE photos ADD COLUMN ocr_text text;
ALTER TABLE photos ADD COLUMN ocr_status text CHECK (ocr_status IN ('auto', 'review', 'approved', 'rejected'));
ALTER TABLE photos ADD COLUMN ocr_at timestamptz;
CREATE INDEX photos_ocr_todo_idx ON photos (created_at) WHERE ocr_at IS NULL AND kind IN ('cover', 'back');
