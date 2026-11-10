-- A reader whose scan waits in a long queue may be told so by email, once (busy.js).
ALTER TABLE scans ADD COLUMN busy_told_at timestamptz;
