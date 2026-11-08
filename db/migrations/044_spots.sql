-- Where a spine is on its shelf photo ("where is this book?"): its outline on the item's frame,
-- as fractions of the photo's width and height ({ poly: [[x, y] x4], how }).
ALTER TABLE scan_items ADD COLUMN spot jsonb;
-- A name the reader gives the place a scan was taken ("living room, left bookcase").
ALTER TABLE scans ADD COLUMN label text;
