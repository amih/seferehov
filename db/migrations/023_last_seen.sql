-- When a reader last opened the app while signed in (updated at most every 10 minutes),
-- for the admin's list of readers.
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
UPDATE users u SET last_seen_at = (SELECT max(created_at) FROM sessions s WHERE s.user_id = u.id);
