-- "Approve, text across": the spine's title runs across the spine (Periodic Tales), so its cut-out
-- is neither upright nor upside down. A label for the upside-down model (lab QUEUE 0z2).
ALTER TABLE scan_items ADD COLUMN text_across boolean NOT NULL DEFAULT false;
