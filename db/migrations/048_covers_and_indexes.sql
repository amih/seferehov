-- Does a book still need a photo of its front / back cover? (No picture of the front at all;
-- no back cover from a catalogue, a library photo, or anyone's My books.) Used for the
-- library page's "needs cover photos", the libraries that need help, and the points for
-- filling the gap.
CREATE OR REPLACE FUNCTION book_lacks_front(bid bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(b.cover_url, b.front_url) IS NULL
     AND NOT EXISTS (SELECT 1 FROM sightings x WHERE x.book_id = b.id AND x.photo_id IS NOT NULL AND x.status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM my_books m WHERE m.book_id = b.id AND m.photo_id IS NOT NULL)
    FROM books b WHERE b.id = bid $$;
CREATE OR REPLACE FUNCTION book_lacks_back(bid bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT b.back_url IS NULL
     AND NOT EXISTS (SELECT 1 FROM sightings x WHERE x.book_id = b.id AND x.back_photo_id IS NOT NULL AND x.status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM my_books m WHERE m.book_id = b.id AND m.back_photo_id IS NOT NULL)
    FROM books b WHERE b.id = bid $$;

-- Indexes for columns hot requests filter on (server review, 10 Nov 2026); all were full scans.
CREATE INDEX IF NOT EXISTS locations_created_by_idx ON locations(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS sightings_user_idx ON sightings(user_id, location_id, book_id, created_at);
CREATE INDEX IF NOT EXISTS scans_location_idx ON scans(location_id, created_at) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_items_book_idx ON scan_items(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_items_sighting_idx ON scan_items(sighting_id) WHERE sighting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_items_my_book_idx ON scan_items(my_book_id) WHERE my_book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS my_books_book_idx ON my_books(book_id);
