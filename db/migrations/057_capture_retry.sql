-- Capture sorting waits when the model is out of reach (graphics card busy with a long job) instead of failing.
ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS retry_after timestamptz, ADD COLUMN IF NOT EXISTS tries int NOT NULL DEFAULT 0;
-- Sessions that failed so (24 Nov 2026: a new reader's first photos, and one of the admin's): sort them again.
UPDATE capture_sessions SET status = 'open', error = NULL WHERE status = 'failed' AND error = 'fetch failed';
