-- Why the reader declined a book (queue): 'reading' = the text read was wrong but the spine's
-- cut-out is good (still a good example for the spine finder); 'cutout' = the cut-out is bad
-- (not one whole spine), whatever the text. NULL: declined before 15 Nov 2026, or no cut-out.
ALTER TABLE scan_items ADD COLUMN decline_why text CHECK (decline_why IN ('reading', 'cutout'));
